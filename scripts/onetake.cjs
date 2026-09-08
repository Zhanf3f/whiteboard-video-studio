#!/usr/bin/env node
/* ============================================================
 * 白板手绘视频 · 一键出片（段落级配音版） onetake.cjs
 *
 * 与旧版（逐句合成）的本质区别：
 *   旧：65 句 → 65 次独立 TTS → 每句都带句末降调 + 固定停顿 = 机器人念稿
 *   新：按自然段 → 每段一次 TTS → 段内逗号平推（阿健式）→ 句间有语气连接
 *       再用 SentenceBoundary 做混合锚点，把段内时间精确摊到每一句，画面仍逐句同步
 *
 * 停顿节奏对齐阿健原片实测（BV1mE411W7NM 204 个气口）：
 *   句间 0.18~0.40s（中位 0.259s）· 段落级 0.40~0.70s
 *
 * 用法：
 *   node onetake.cjs "文案" [out.mp4] [--preset ajian] [--voice ...] [--rate +30%] [--seed 7]
 *   node onetake.cjs 文案.txt [out.mp4] ...
 * 音色预设 --preset：ajian（默认，云健+30% 低沉男声·从容语速）/ yunxi（云希温和）/ yunyang（云扬播音）
 * 依赖：edge-tts (python)、imageio-ffmpeg 完整版、puppeteer + chrome-headless-shell 131
 * ============================================================ */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* ---------- 可移植环境探测 ----------
 * 优先环境变量，其次自动探测。作者本机是 macOS + homebrew 系工具链；
 * 其它平台/容器请用环境变量显式指定：
 *   ONETAKE_PYTHON / FFMPEG / ONETAKE_CHROME
 * puppeteer 优先取本地 npm 安装，取不到再回退作者常用路径。 */
const HOME = os.homedir();
const exists = p => { try { fs.accessSync(p); return p; } catch { return null; } };
const which = cmd => { try { return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
const firstOf = (...xs) => xs.find(Boolean) || null;

const NODE = process.execPath;                                  // 直接复用当前 node
const PY   = process.env.ONETAKE_PYTHON || which('python3') || 'python3';
const FF   = process.env.FFMPEG || firstOf(
  exists(path.join(HOME, '.workbuddy/binaries/python/envs/default/lib/python3.13/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1')),
  exists('/opt/homebrew/bin/ffmpeg'),
  exists('/usr/local/bin/ffmpeg'),
  which('ffmpeg'));

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch { /* 下面回退常见路径 */ }
if (!puppeteer) {
  for (const cand of [path.join(HOME, '.workbuddy/binaries/node/workspace/node_modules/puppeteer'),
                      path.join(__dirname, '..', 'node_modules', 'puppeteer')]) {
    if (exists(path.join(cand, 'package.json'))) { puppeteer = require(cand); break; }
  }
}
const SHELL = process.env.ONETAKE_CHROME || firstOf(
  exists(puppeteer && puppeteer.executablePath && puppeteer.executablePath()),
  exists(path.join(HOME, '.cache/puppeteer/chrome-headless-shell/mac_arm-131.0.6778.204/chrome-headless-shell-mac-arm64/chrome-headless-shell')));

const TTS  = path.join(__dirname, 'tts_para.py');
const TOOL = path.join(__dirname, '..', 'src', 'whiteboard-video-tool.html');
const TMP  = '/tmp/onetake_cache';
fs.mkdirSync(TMP, { recursive: true });

/* ---------- 参数 ---------- */
let args = process.argv.slice(2);
let text, out = path.join(process.cwd(), '白板手绘视频-配音版.mp4');

/* 音色预设（2026-09-05 敲定）：换音色=换整套参数，一条 --preset 搞定，不再散改。
   每个音色的 rate + 逗号/句号停顿是耦合的，实测标定值如下（换音色必须连同停顿一起换，否则断句全乱）。 */
const PRESETS = {
  ajian:   { voice:'zh-CN-YunjianNeural', rate:'+30%', pitch:'', comma:0.17, period:0.52, inner:0.17 }, // 阿健范式：云健男声。语速降档 +30%=5.49字/s（2026-09-05 用户嫌 +40% 快；5.49 比阿健5.81 慢5%更从容）。基频138Hz贴127Hz
  yunxi:   { voice:'zh-CN-YunxiNeural',   rate:'+45%', pitch:'', comma:0.30, period:0.52, inner:0.28 }, // 云希：阳光青年，音色温和但逗号停顿长
  yunyang: { voice:'zh-CN-YunyangNeural', rate:'+25%', pitch:'', comma:0.08, period:0.55, inner:0.10 }, // 云扬：播音腔，逗号快连句号才停
};

let preset = 'ajian';
let voice = '', rate = '', pitch = '';
let seed = 7;
let paraGap = 0.45;          // 段落间停顿（阿健段落级 0.40~0.70s，取中位偏下，替代段末句号停顿）
let groupChars = 28;         // 锚点组目标字数：每攒够这么多字放一个句号做时间锚点
let commaPause = 0, periodPause = 0, innerPeriodPause = 0;

while (args.length) {
  const a = args.shift();
  if (a === '--preset') preset = args.shift();
  else if (a === '--voice') voice = args.shift();
  else if (a === '--rate') rate = args.shift();
  else if (a === '--pitch') pitch = args.shift();
  else if (a === '--seed') seed = parseInt(args.shift(), 10);
  else if (a === '--gap') paraGap = parseFloat(args.shift());
  else if (a === '--group') groupChars = parseInt(args.shift(), 10);
  else if (a.endsWith('.mp4')) out = a;
  else if (a.endsWith('.txt') || fs.existsSync(a) && fs.statSync(a).isFile()) text = fs.readFileSync(a, 'utf8');
  else text = a;
}
// 预设套用（--voice/--rate/--pitch 可覆盖预设的单点参数）
const P = PRESETS[preset] || PRESETS.ajian;
if (!voice) voice = P.voice;
if (!rate) rate = P.rate;
if (pitch === '') pitch = P.pitch;
commaPause = P.comma; periodPause = P.period; innerPeriodPause = P.inner;

if (!text || !text.trim()) { console.error('用法：node onetake.cjs "文案" 输出.mp4 [--preset ajian] [--voice ...] [--rate +40%]'); process.exit(1); }
text = text.trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...x) => console.log('[onetake]', ...x);

/* ---------- ffmpeg 工具 ---------- */
function ff(argsArr, input) {
  return input ? execFileSync(FF, argsArr, { input, maxBuffer: 1e9 }) : execFileSync(FF, argsArr, { maxBuffer: 1e9 });
}
function mp3Duration(file) {
  const r = spawnSync(FF, ['-i', file], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) throw new Error('读不到音频时长 ' + file);
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}
const SR = 44100;          // 全局采样率（画面/音频共用同一套时间基准）
/**
 * 直接从 PCM 波形量音频尾部静音：段落末尾 TTS 自带一段静音，算段落间隔时要扣掉，
 * 否则每个段落都会多出 0.3s 左右、14 段全是长停顿。
 * 比 ffmpeg silencedetect 可靠——后者在 mp3 尾部低电平噪声上常常检测不到，返回 0 导致扣减失效
 */
function pcmTailSilence(buf, thresh = 250) {
  const n = buf.length / 2;                 // s16le 单声道采样数
  const win = Math.floor(SR * 0.01);        // 10ms 窗口
  let i = n;
  while (i > win) {
    let sum = 0;
    for (let k = i - win; k < i; k++) { const v = buf.readInt16LE(k * 2); sum += v * v; }
    if (Math.sqrt(sum / win) > thresh) break;
    i -= win;
  }
  return (n - i) / SR;
}
/** 疑问句单独成锚点组：保住疑问语调，同时仍是一个断句点 */
const isQuestion = s => /(吗|呢|什么|怎么|哪儿|哪里|为什么|谁|哪[个性些]|多少)/.test(s);

/** 段落内句子 → 锚点组：组内逗号平推（连贯），组末句号（时间锚点） */
function makeGroups(sents) {
  const groups = []; let cur = []; let c = 0;
  for (const s of sents) {
    cur.push(s); c += s.length;
    const end = isQuestion(s) || c >= groupChars;
    if (end) { groups.push(cur); cur = []; c = 0; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}
/** 把锚点组时间摊到组内每句。两个独立累加器：
 * start（真实坐标，供 starts 用）：组首 = off（SentenceBoundary 精确 offset），
 *   组内按字数估算，末句后 + realEndPause（真实句号停顿），保证下一组首句精确对位。
 * dur（占时，供 holds 用）：末句后 + endPause（裁后停顿），裁短它就能裁掉句号停顿。
 * 两者分家：裁 holds 不影响 starts 的真实对位。
 */
function spreadGroup(off, speakDur, sents, commaPause, endPause, realEndPause) {
  const n = sents.length;
  const chars = sents.map(s => s.length);
  const total = chars.reduce((a, b) => a + b, 0);
  const out = [];
  let realAcc = off;
  for (let i = 0; i < n; i++) {
    const speak = speakDur * (chars[i] / total);
    const inner = i < n - 1;
    out.push({ start: realAcc, dur: speak + (inner ? commaPause : endPause) });
    realAcc += speak + (inner ? commaPause : realEndPause);
  }
  return out;
}

(async () => {
  const tStart = Date.now();

  /* ---------- ① 无头页：取与画面同源的分句，并按自然段归组 ---------- */
  const browser = await puppeteer.launch({
    executablePath: SHELL, headless: 'shell',
    args: ['--no-sandbox','--disable-gpu','--single-process','--user-data-dir=/tmp/chs_onetake','--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErr = [];
  page.on('pageerror', e => pageErr.push(String(e)));
  await page.goto('file://' + TOOL, { waitUntil: 'load' });
  await sleep(600);

  const parasRaw = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const grouped = await page.evaluate(ps => ps.map(p => splitSentences(p)), parasRaw);
  const sentences = grouped.flat();
  log(`分句 ${sentences.length} 幕 · ${parasRaw.length} 个自然段`);

  /* ---------- ② 段落级 TTS：一段一次合成，拿 SentenceBoundary ---------- */
  const COMMA_PAUSE = commaPause;       // 逗号停顿估值（来自预设 PRESETS[preset].comma）
  const PERIOD_PAUSE = periodPause;     // 句号停顿（来自预设，音色耦合，云健0.30/云希0.52/云扬0.55）
  const INNER_PERIOD_PAUSE = innerPeriodPause; // 段内锚点句号裁到逗号级
  const paraMeta = [];               // {mp3, dur, bounds, sents}
  let paraStart = 0;
  for (let pi = 0; pi < grouped.length; pi++) {
    const sents = grouped[pi];
    if (!sents.length) continue;
    const groups = makeGroups(sents);
    // 组内逗号连接（平推连贯），组末句号/问号（断句锚点）
    const ttsText = groups.map(g => g.join('，') + (isQuestion(g[g.length - 1]) ? '？' : '。')).join('');
    const key = crypto.createHash('md5').update(voice + rate + pitch + ttsText).digest('hex').slice(0, 12);
    const mp3 = path.join(TMP, 'para_' + key + '.mp3');
    const jsn = path.join(TMP, 'para_' + key + '.json');

    if (!fs.existsSync(mp3) || !fs.existsSync(jsn)) {
      const tf = path.join(TMP, 'para_' + key + '.txt');
      fs.writeFileSync(tf, ttsText, 'utf8');
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {           // 段落级重试：整段重来，缓存安全
        const r = spawnSync(PY, [TTS, voice, rate, tf, mp3, jsn, pitch], { encoding: 'utf8', timeout: 120000 });
        if (r.status === 0 && fs.existsSync(mp3) && fs.existsSync(jsn)) ok = true;
        else { log(`  段落 ${pi + 1} 合成失败，${a < 2 ? '8s 后重试' : ''}`, (r.stderr || '').slice(0, 160)); if (a < 2) execFileSync('/bin/sleep', ['8']); }
      }
      if (!ok) throw new Error(`段落 ${pi + 1} TTS 三次都失败，终止`);
      execFileSync('/bin/sleep', ['1.2']);           // 段间冷却，摊开请求
    }
    const bounds = JSON.parse(fs.readFileSync(jsn, 'utf8'));
    if (bounds.length !== groups.length) {
      log(`  ⚠ 段落 ${pi + 1} 锚点数 ${bounds.length} ≠ 组数 ${groups.length}，降级为整段均摊`);
    }
    const dur = mp3Duration(mp3);
    paraMeta.push({ mp3, dur, bounds, sents, groups, ttsText });
    log(`配音段 ${pi + 1}/${grouped.length}  ${dur.toFixed(2)}s · ${sents.length}句 · ${groups.length}锚点`);
  }

  // 统一解码：顺手量出每段尾部静音，后面算段落间隔和拼接都直接用
  for (const p of paraMeta) {
    p.raw = ff(['-i', p.mp3, '-f', 's16le', '-ac', '1', '-ar', String(SR), 'pipe:1']);
    p.tail = pcmTailSilence(p.raw);
  }
  log(`段落尾部静音 中位 ${paraMeta.map(p => p.tail).sort((a, b) => a - b)[Math.floor(paraMeta.length / 2)].toFixed(2)}s`);

  /* ---------- ③ 时间轴：段落起始 → 锚点 → 每句 ---------- */
  const holds = [];        // 每句占时（裁后，含句后气口）
  const starts = [];       // 每句真实起始（音频坐标，切点定位用）
  let si = 0;
  let t = 0;
  for (const p of paraMeta) {
    p.__start = t;                 // 段落全局起始：句子级 PCM 切分要靠它定位
    let idx = 0;
    if (p.bounds.length === p.groups.length) {
      for (let gi = 0; gi < p.groups.length; gi++) {
        const b = p.bounds[gi], g = p.groups[gi];
        const isLast = (gi + 1 === p.groups.length);
        const n = g.length;
        const commaTotal = (n - 1) * COMMA_PAUSE;
        // 纯发声时长：段末组用 p.tail 精确扣句号停顿；段内组用 PERIOD_PAUSE 估值扣
        const speakDur = isLast
          ? Math.max(0.3, (p.dur - p.tail) - b.offset - commaTotal)
          : Math.max(0.3, b.duration - PERIOD_PAUSE - commaTotal);
        // 真实组末结束点（音频坐标）：段内组=下一锚点 offset（精确对位），段末组=发声结束
        const realEnd = isLast ? (p.dur - p.tail) : p.bounds[gi + 1].offset;
        // 真实句号停顿 = 真实组占时 - 纯发声 - 逗号（吸收估值误差，保证切点精确）
        const realEndPause = Math.max(0, (realEnd - b.offset) - speakDur - commaTotal);
        // 裁后停顿：段内组=逗号级（裁掉句号停顿，阿健是逗号平推），段末组=段落级 paraGap
        const endPause = isLast ? paraGap : INNER_PERIOD_PAUSE;
        const sp = spreadGroup(b.offset, speakDur, g, COMMA_PAUSE, endPause, realEndPause);
        for (const one of sp) { starts.push(t + one.start); holds.push(one.dur); }
      }
    } else {
      // 兜底：整段按字数均摊
      const chars = p.sents.map(s => s.length), total = chars.reduce((a, b) => a + b, 0);
      let acc = 0;
      for (let k = 0; k < p.sents.length; k++) {
        starts.push(t + acc); const d = p.dur * (chars[k] / total); holds.push(d); acc += d;
      }
    }
    // 段落推进：真实发声结束 + 段落级停顿
    t += (p.dur - p.tail) + paraGap;
    si += p.sents.length;
  }
  const audioTotal = t;
  const sorted = holds.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  log(`配音总长 ${audioTotal.toFixed(2)}s · 句数 ${starts.length}`);
  log(`句占时 · 最短 ${sorted[0].toFixed(2)}s / 中位 ${med.toFixed(2)}s / 最长 ${sorted[sorted.length - 1].toFixed(2)}s`);
  log(`         <1.0s ${holds.filter(h => h < 1.0).length} 句 · <0.7s ${holds.filter(h => h < 0.7).length} 句 · <0.5s ${holds.filter(h => h < 0.5).length} 句`);

  // 短句画面下限：配音不足 MIN_SCENE 的，画面补到 MIN_SCENE，音频侧同步补静音（拼接时按句切段补齐）。
  // 画面与音频用同一个 finalDurs 推进，所以补留白不会造成音画错位
  // 标定结论：纯字数分摊就是最优（MAE 0.105s，加权模型反而更差）；锚点组放大到 55+ 组数降不下来、
  // 组内漂移却翻倍。所以长停顿只能从 MIN_SCENE 补静音和段落间隙这两处省
  const MIN_SCENE = 0.75;
  const finalDurs = holds.map(h => Math.max(MIN_SCENE, h));
  const audioTotal2 = finalDurs.reduce((a, b) => a + b, 0);

  /* ---------- ④ 画面：精确时长驱动构图（exactDurs） ---------- */
  const voiceDurs = finalDurs.slice();
  const shot = await page.evaluate(async (txt, vds, sd) => {
    project = buildScenes(txt, 1, sd, vds, true);
    const meta = { durs: project.scenes.map(s => s.dur), t0s: project.scenes.map(s => s.t0), total: project.total };
    window.__dl = null; window.__expErr = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) window.__dl = { name: this.download, url: this.href };
      return orig.call(this);
    };
    exportMP4().catch(e => window.__expErr = String(e));
    return meta;
  }, text, voiceDurs, seed);
  log(`画面 ${shot.durs.length} 幕 · 总长 ${shot.total.toFixed(2)}s`);

  // 音画对齐：画面 t0 与音频输出位置都用 finalDurs 累加推进，天然一致（不另算 starts，那套是 raw 切点坐标）
  // 真正的同步校验交给 verify_sync.py（检测成片音频语音起始点 vs 预期位置）
  log(`画面 ${shot.durs.length} 幕 · 总长 ${shot.total.toFixed(2)}s`);
  // 时间轴落盘：audioStart 用「输出位置」= finalDurs 累加（= 画面 t0），供外部语音起始点比对
  let outPos = 0;
  const tlOut = shot.durs.map((d, i) => {
    const o = { i: i + 1, t0: +outPos.toFixed(3), audioStart: +outPos.toFixed(3),
                dur: +d.toFixed(3), sen: sentences[i] };
    outPos += d;
    return o;
  });
  fs.writeFileSync(path.join(TMP, 'timeline.json'), JSON.stringify(tlOut, null, 1));

  let dl = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(1500);
    const st = await page.evaluate(() => ({ dl: window.__dl, err: window.__expErr,
      status: ((document.getElementById('statusEl') || {}).textContent || '').slice(0, 80) }));
    if (st.err) throw new Error('页面导出异常：' + st.err);
    if (st.dl) { dl = st.dl; break; }
  }
  if (!dl) throw new Error('导出超时（headless WebCodecs 未产出文件）');
  const vB64 = await page.evaluate(async u => {
    const buf = await (await fetch(u)).arrayBuffer();
    let s = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }, dl.url);
  const vPath = path.join(TMP, 'video.mp4');
  fs.writeFileSync(vPath, Buffer.from(vB64, 'base64'));
  log(`画面导出完成 ${(fs.statSync(vPath).size / 1048576).toFixed(2)}MB`);
  await browser.close();

  /* ---------- ⑤ 配音轨：整段 PCM 按段落起始摆位（段内天然连贯） ---------- */
  const totalS = Math.max(audioTotal2, shot.total) + 1.0;
  const pcm = Buffer.alloc(Math.ceil(totalS * SR) * 2);   // s16le mono，静音即 0
  // 句子级切段：段内整段是连贯语流，按每句的时间戳切开，短句后面补静音凑到 MIN_SCENE。
  // 切点误差只在锚点组内（组间由 SentenceBoundary 重置），不会跨段累积
  let cursor = 0;   // 音频写入位置（秒），与画面 t0 用同一套 finalDurs 推进
  let gi = 0;       // 全局句子序号
  for (const p of paraMeta) {
    const raw = p.raw;                                     // 已在 ② 后统一解码
    // 每段 TTS 音频开头自带约 0.1s 前置静音（SentenceBoundary 首个 offset 恒为 0.1）。
    // 第一句要从 raw 的 0 取起、把这段静音保留下来，否则整段语音会比时间轴早 headPad
    const headPad = (p.bounds && p.bounds.length) ? p.bounds[0].offset : 0;
    for (let k = 0; k < p.sents.length && gi < holds.length; k++, gi++) {
      const relStart = starts[gi] - p.__start;                       // 句在段内的相对起点（秒）
      const pad = (k === 0) ? headPad : 0;
      const b0 = (k === 0) ? 0 : Math.max(0, Math.floor(relStart * SR)) * 2;
      const b1 = Math.min(raw.length, Math.ceil((relStart + holds[gi] + pad) * SR) * 2);
      const at = Math.round(cursor * SR) * 2;
      if (b1 > b0) raw.copy(pcm, at, b0, Math.min(b1, b0 + (pcm.length - at)));
      cursor += finalDurs[gi];                                        // 画面音频同步推进
    }
  }
  const wav = path.join(TMP, 'voice.wav');
  const wh = Buffer.alloc(44);
  wh.write('RIFF', 0); wh.writeUInt32LE(36 + pcm.length, 4); wh.write('WAVE', 8);
  wh.write('fmt ', 12); wh.writeUInt32LE(16, 16); wh.writeUInt16LE(1, 20); wh.writeUInt16LE(1, 22);
  wh.writeUInt32LE(SR, 24); wh.writeUInt32LE(SR * 2, 28); wh.writeUInt16LE(2, 32); wh.writeUInt16LE(16, 34);
  wh.write('data', 36); wh.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wav, Buffer.concat([wh, pcm]));
  log(`配音轨拼接完成 ${(pcm.length / SR / 2).toFixed(2)}s → voice.wav`);   // s16le 每采样 2 字节

  /* ---------- ⑥ 混流 ---------- */
  ff(['-y', '-i', vPath, '-i', wav, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-t', shot.total.toFixed(3), '-movflags', '+faststart', out]);
  const size = fs.statSync(out).size / 1048576;
  const info = spawnSync(FF, ['-i', out], { encoding: 'utf8' }).stderr || '';
  const dM = info.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  const dur = dM ? (+dM[1]) * 3600 + (+dM[2]) * 60 + parseFloat(dM[3]) : NaN;
  log(`完成 ✔ ${out}`);
  log(`  时长 ${dur.toFixed(2)}s · ${size.toFixed(1)}MB · 音轨 ${/Audio: aac/.test(info) ? 'AAC ✓' : '缺失 ✗'}`);
  log(`  配音 ${voice}（${rate}）· 段落间停顿 ${paraGap}s · 耗时 ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
})().catch(e => { console.error('[onetake] 失败：', e.message || e); process.exit(1); });

# whiteboard-video-studio · 白板手绘短视频生成器

> 写完文案，按一下回车，就有一支带配音、逐笔手绘的短视频。
> 单文件 HTML 工具 + Node 一键出片管线，专为"不会剪、不会画、不会配"的内容创作者设计。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](#)
[![Tech: Canvas](https://img.shields.io/badge/tech-Canvas%20%7C%20WebCodecs%20%7C%20edge--tts-blue)](#)

---

## 一句话说明

白板手绘视频生成器 = **文案 → 分镜 → Canvas 逐笔手绘动画 + 段落级 TTS 配音 → MP4 成片**。
整套工具链跑在一个浏览器标签页和一个 Node 进程里，不需要 Premiere、AE、剪映、任何设计软件。

## 为什么做这个

我在 B 站和公众号做深度长文视频化，剪辑软件学不会、找外包又贵又慢、AI 念稿一股机器人腔。
我想要的是：**专注"想清楚这一帧要表达什么"**——把构图、笔顺、断句这些执行层全部交给工具。

三个月迭代下来，这套流水线已经稳定产出 30+ 条成片（覆盖社会议题、产业分析、人物解说）。
本仓库公开的是生成器本体，去掉了发布相关的私有模板与历史成片。

## 核心特性

- **零安装上手**：浏览器双击 `src/whiteboard-video-tool.html` 即开即用（生成分镜 → 预览 → 导出 MP4）。
- **逐笔手绘动画**：每个分镜按时间戳重放真实笔顺，不是关键帧插值；看起来"有人在画"，不是"画面淡入"。
- **段落级 TTS 配音**：一次合成整段语音，逗号平推、句号断气，避免"逐句合成 = 机器人念稿"。
- **混合时间锚点**：用 `SentenceBoundary` 精确对位画面，音画误差控制在一个句号停顿内。
- **三套音色预设**：`ajian`（云健+30%·从容男声）/ `yunxi`（云希温和）/ `yunyang`（云扬播音），每套音色自带配套的停顿节奏，不能乱套。
- **一键出片管线**：`onetake.cjs` 一条命令完成"分句 → TTS → 画面导出 → 配音轨拼接 → 混流 MP4"。

## 架构

```
┌─────────────────────────────────────────────┐
│  src/whiteboard-video-tool.html             │  ← 浏览器端单文件工具
│  ─────────────────────────────────          │
│  splitSentences  →  断句/分词                │
│  buildScenes     →  分镜构图 + 笔顺时间轴      │
│  drawScene       →  Canvas 逐笔渲染          │
│  exportMP4       →  WebCodecs 视频编码        │
└──────────────┬──────────────────────────────┘
               │  page.evaluate 注入文本+时长
               ▼
┌─────────────────────────────────────────────┐
│  scripts/onetake.cjs                        │  ← Node 一键出片
│  ─────────────────────────────────          │
│  ① 拉起 headless chrome 打开 HTML 工具       │
│  ② 段落级合成 edge-tts + 拿 SentenceBoundary │
│  ③ 按字数 + 真实锚点铺平句级时间轴            │
│  ④ 导出无配音画面 MP4（WebCodecs）           │
│  ⑤ PCM 拼接配音轨（短句补静音到 MIN_SCENE）  │
│  ⑥ ffmpeg 混流 → out.mp4                    │
└─────────────────────────────────────────────┘
```

## 快速开始

### 1. 浏览器试用（无需任何依赖）

```bash
open src/whiteboard-video-tool.html
```

左侧贴文案，点「生成分镜」→「播放预览」→「导出 MP4」。WebCodecs 在 Chrome/Edge 最新版上原生支持。

### 2. 一键出片（带配音）

依赖：Node ≥ 18 · Python 3.9+（`pip install edge-tts`）· ffmpeg · Chrome（headless 模式可用 puppeteer 内置）· puppeteer

```bash
git clone https://github.com/<your-account>/whiteboard-video-studio.git
cd whiteboard-video-studio

# 默认从 brew 或 $PATH 探测工具；非默认路径用环境变量显式指定：
export ONETAKE_PYTHON=/opt/homebrew/bin/python3
export FFMPEG=/opt/homebrew/bin/ffmpeg
# ONETAKE_CHROME 不指定时优先取 puppeteer 内置 chrome

node scripts/onetake.cjs "你的文案，一次性贴进来，空行分段。" out.mp4
# 或从文件读：
node scripts/onetake.cjs script.txt out.mp4 --preset ajian --gap 0.45
```

可选参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--preset` | `ajian` | `ajian`（云健+30%·低沉男声）/`yunxi`（云希温和）/`yunyang`（云扬播音） |
| `--voice` | 预设值 | 临时覆盖音色 ID（仍按预设停顿） |
| `--rate` | 预设值 | 临时覆盖语速，如 `+30%` |
| `--pitch` | 预设值 | 临时覆盖音调 |
| `--gap` | `0.45` | 段落间停顿秒数（阿健原片实测 0.40~0.70） |
| `--group` | `28` | 锚点组目标字数；越大断句越稀疏 |
| `--seed` | `7` | 构图随机种子；`--reroll` 同源对比 |
| `out` | `白板手绘视频-配音版.mp4` | 输出路径 |

## 关键实现说明

### 段落级配音 vs 逐句合成

逐句 TTS 听起来像机器人，是因为每句都带句末降调 + 固定停顿。本工具改成"按自然段一次合成"，段内逗号平推、句间有语气连接，模拟真人说话节奏。

代价是断句时间点不再在段内显式存在。解法：用 `edge_tts` 流式输出的 `SentenceBoundary` 事件拿到每个句子的精确 offset/duration，再以**字数比例**把段内时间摊到每句。误差用"末句后 + realEndPause"做平滑吸收（详见 `onetake.cjs: spreadGroup`）。

### 音画同基准

画面总长 = 配音总长 = 句级 `finalDurs` 累加（每句最短 `MIN_SCENE = 0.75s`，不足补静音）。
两端共用同一套时间累加器，从根上规避音画漂移；成片后用 ffmpeg 直接打 `SpeechStart` 标签可以二次校验。

### PCM 尾部静音测量

`ffmpeg silencedetect` 在低码率 mp3 尾部噪声上常常返回 0。改用 `s16le` 解码后从尾向头算窗口 RMS，得到更可靠的尾部静音长度——扣掉它，每个段落才不会多出 0.3s 长停顿。

## 目录结构

```
whiteboard-video-studio/
├── src/
│   └── whiteboard-video-tool.html   # 浏览器端工具主体（单文件）
├── scripts/
│   ├── onetake.cjs                  # 一键出片管线
│   └── tts_para.py                  # edge-tts 段落级封装
├── docs/
│   └── ARCHITECTURE.md              # 内部架构补充说明
├── README.md
├── LICENSE
└── .gitignore
```

## 已知限制

- WebCodecs 需 Chrome / Edge / Opera 现代版本；Safari 暂不支持（会卡在编码步骤）。
- ffmpeg / puppeteer / edge-tts 都需在系统路径或环境变量里；本机有 `ONETAKE_PYTHON / FFMPEG / ONETAKE_CHROME` 三个口子。
- 分镜依赖规则集内置的"实词 → 元素"映射，扩展元素库需改 `src/whiteboard-video-tool.html` 里的元素库。

## Roadmap

- [ ] 9:16 竖版原生支持（当前需手工调构图坐标）
- [ ] 分镜→元素库可由用户自定义 JSON 注入
- [ ] 字幕拆条导出（SRT）

## 关于作者

**张承浩**（账号：在下张叁疯）

大连财经学院商学院市场营销专业 2023 级本科生，自媒体全网运营者，专注汽车/数码/AI 三圈深度长文。

数据战绩（截至 2026-09）：

| 平台 | 关键指标 |
| --- | --- |
| 公众号「在下张叁疯」 | 300+ 篇原创 · 单篇最高 12.8 万阅读 |
| 视频号 + 抖音 | 累计 400 万+ 播放 |
| 小红书 | 单篇 20 万观看 |
| 内容生产 | 本工具自用，已支撑 30+ 条成片视频 |

本仓库是该生产线**最核心的一段**：把"想好要表达什么"自动变成"能看见的、带人声的短视频"。

如果你也在用 AI 做内容、希望有同样的工具，欢迎提 Issue / PR。

## License

MIT — 拿去用，标不标注都行。

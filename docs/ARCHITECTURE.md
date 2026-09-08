# ARCHITECTURE · 内部架构说明

> 给需要二次开发或排查问题的同学；公开 API 在 [README.md](./README.md)。

## 双层结构

工具由两层组成，每层可以独立使用：

1. **`src/whiteboard-video-tool.html`** — 浏览器端单文件工具
   - 暴露三个全局函数：`splitSentences(text)` / `buildScenes(text, ...)` / `exportMP4()`
   - 视觉态（Preview）+ 数据态（`project.scenes[]`）分离，方便被外部脚本驱动
   - WebCodecs 编码后用 `Blob URL` 触发下载，被 `onetake.cjs` 抓回 base64

2. **`scripts/onetake.cjs`** — Node 一键出片
   - 通过 `puppeteer` 拉起 headless chrome 加载工具 HTML
   - 用 `page.evaluate` 注入文本和每句时长
   - 监听 `window.__dl` 抓取渲染好的视频 blob
   - 段落级 edge-tts 合成 + PCM 自拼接 + ffmpeg 混流

## 时间轴设计

`finalDurs[]` 是音画共同的"真相"——所有时间累加都从这数组出发。`starts[]` 是另一套"raw 音频坐标"，只供句子级 PCM 切段定位用。两套坐标系通过 `spreadGroup` 严格区分（裁 vs 不裁句号停顿），避免互相污染。

## 元素库扩展

`src/whiteboard-video-tool.html` 内置一份"实词 → 元素"映射字典。扩展它意味着改文件里固定的几个数组 + 重画 Canvas 的元素库。

---

有问题欢迎开 Issue，把"现象 + 复现命令 + 系统环境"贴清楚就行。

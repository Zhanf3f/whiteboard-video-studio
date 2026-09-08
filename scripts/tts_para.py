#!/usr/bin/env python3
"""段落级 TTS：一次合成一整个段落（语音连贯），同时输出每句 SentenceBoundary 时间戳。
用法: python3 tts_para.py <voice> <rate> <text_file> <out_mp3> <out_json>
输出 out_json: [{"offset":秒, "duration":秒, "text":"..."}, ...]
"""
import asyncio, json, sys, os

import edge_tts


async def synth(voice, rate, text, mp3_path):
    c = edge_tts.Communicate(text, voice, rate=rate)
    audio = bytearray()
    bounds = []
    async for ch in c.stream():
        t = ch.get("type")
        if t == "audio":
            audio.extend(ch["data"])
        elif t == "SentenceBoundary":
            # offset/duration 单位 100ns
            bounds.append({
                "offset": ch.get("offset", 0) / 1e7,
                "duration": ch.get("duration", 0) / 1e7,
                "text": ch.get("text", ""),
            })
    if not audio:
        raise RuntimeError("no audio received")
    with open(mp3_path, "wb") as f:
        f.write(bytes(audio))
    return bounds


def main():
    voice, rate, tf, mp3_path, json_path = sys.argv[1:6]
    text = open(tf, encoding="utf-8").read().strip()
    # 网络抖动重试
    last = None
    for attempt in range(3):
        try:
            bounds = asyncio.run(synth(voice, rate, text, mp3_path))
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(bounds, f, ensure_ascii=False, indent=1)
            print("OK %d bounds" % len(bounds))
            return 0
        except Exception as e:
            last = e
            if attempt < 2:
                import time
                time.sleep(4 * (attempt + 1))
    print("FAIL: %s" % last, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

"""Transcribe media files locally. Usage: transcribe.py FILE...  ->  JSON {file: text|null} on stdout."""
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
from faster_whisper import WhisperModel

model = WhisperModel(os.environ.get("SD_WHISPER_MODEL", "base"), device="cpu", compute_type="int8")
# biases spelling of terms Whisper otherwise mishears (it hears "Claude" as "Cloud")
PROMPT = "Claude Code, Claude, Anthropic, Codex, OpenAI, Cursor, GitHub, MCP, npm, npx, API, LLM, TypeScript, Next.js, Supabase."
out = {}
n = len(sys.argv) - 1
for i, f in enumerate(sys.argv[1:], 1):
    try:
        segments, _ = model.transcribe(f, vad_filter=True, initial_prompt=PROMPT)  # vad skips music/silence, which Whisper otherwise hallucinates over
        out[f] = " ".join(s.text.strip() for s in segments)
    except Exception as e:
        print(f"{f}: {e}", file=sys.stderr)
        out[f] = None
    if i == 1 or i % 10 == 0 or i == n:
        print(f"  transcribed {i}/{n}", file=sys.stderr, flush=True)  # progress; stdout carries the JSON result
print(json.dumps(out))

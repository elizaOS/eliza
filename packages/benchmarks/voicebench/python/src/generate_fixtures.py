from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
VOICEBENCH_DIR = PYTHON_DIR.parent
WORKSPACE_ROOT = VOICEBENCH_DIR.parent.parent
SHARED_DIR = VOICEBENCH_DIR / "shared"

# Make local workspace packages importable without separate installation.
sys.path.insert(0, str(WORKSPACE_ROOT / "eliza/packages/python"))
sys.path.insert(0, str(WORKSPACE_ROOT / "plugins/plugin-groq/python"))
sys.path.insert(0, str(WORKSPACE_ROOT / "plugins/plugin-elevenlabs/python/src"))

from elizaos.types.model import ModelType

from .bench import (
    coerce_audio_bytes,
    create_runtime,
    load_json,
    split_first_sentence,
    to_python_character,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate labeled voicebench TTS fixtures")
    parser.add_argument("--profile", choices=["groq", "elevenlabs"], default="groq")
    parser.add_argument(
        "--prompts",
        default=str(SHARED_DIR / "fixture_prompts.jsonl"),
        help="Path to JSONL prompt file with {id,text}",
    )
    parser.add_argument(
        "--output-dir",
        default=str(VOICEBENCH_DIR / "fixtures"),
        help="Directory where fixture audio + manifest will be written",
    )
    parser.add_argument(
        "--manifest-name",
        help="Manifest file name (default: manifest-<profile>.json)",
    )
    parser.add_argument("--voice")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--limit", type=int)
    return parser.parse_args()


def load_prompts(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")

    prompts: list[dict[str, str]] = []
    for line_no, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parsed = json.loads(line)
        prompt_id = str(parsed.get("id") or f"sample-{line_no}")
        text = parsed.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Invalid prompt text at line {line_no}")
        prompts.append({"id": prompt_id, "text": text.strip()})
    if not prompts:
        raise ValueError(f"No prompts found in {path}")
    return prompts


def pick_output_extension(profile: str) -> str:
    if profile == "groq":
        return "wav"
    return "mp3"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def run() -> None:
    args = parse_args()
    prompts_path = Path(args.prompts).resolve()
    output_dir = Path(args.output_dir).resolve()
    manifest_name = args.manifest_name or f"manifest-{args.profile}.json"
    manifest_path = output_dir / manifest_name

    prompts = load_prompts(prompts_path)
    if args.limit is not None and args.limit > 0:
        prompts = prompts[: args.limit]

    character = to_python_character(load_json(SHARED_DIR / "character.json"))
    runtime = await create_runtime(args.profile, character)
    tts_provider = "elevenLabs" if args.profile == "elevenlabs" else "groq"
    extension = pick_output_extension(args.profile)
    audio_dir = output_dir / args.profile
    audio_dir.mkdir(parents=True, exist_ok=True)

    samples: list[dict[str, Any]] = []
    try:
        for index, prompt in enumerate(prompts, start=1):
            sample_id = prompt["id"]
            text = prompt["text"]
            target_path = audio_dir / f"{sample_id}.{extension}"

            if target_path.exists() and not args.overwrite:
                audio_bytes = target_path.read_bytes()
            else:
                params: dict[str, Any] = {"text": text}
                if isinstance(args.voice, str) and args.voice:
                    params["voice"] = args.voice
                started = time.perf_counter_ns()
                tts_output = await runtime.use_model(
                    ModelType.TEXT_TO_SPEECH,
                    params,
                    provider=tts_provider,
                )
                elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000
                audio_bytes = coerce_audio_bytes(tts_output)
                target_path.write_bytes(audio_bytes)
                print(
                    f"[voicebench][fixtures] generated {sample_id} ({len(audio_bytes)} bytes, {elapsed_ms:.2f}ms)"
                )

            first_sentence, remainder = split_first_sentence(text)
            samples.append(
                {
                    "id": sample_id,
                    "text": text,
                    "firstSentence": first_sentence,
                    "hasRemainder": bool(remainder),
                    "audioPath": str(target_path),
                    "audioBytes": len(audio_bytes),
                    "audioSha256": sha256_hex(audio_bytes),
                    "provider": tts_provider,
                    "profile": args.profile,
                }
            )

            if index % 5 == 0:
                print(f"[voicebench][fixtures] processed {index}/{len(prompts)} prompts")
    finally:
        await runtime.stop()

    manifest = {
        "datasetName": f"voicebench-ground-truth-{args.profile}",
        "profile": args.profile,
        "generatedAtMs": int(time.time() * 1000),
        "promptFile": str(prompts_path),
        "sampleCount": len(samples),
        "samples": samples,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"[voicebench][fixtures] manifest -> {manifest_path}")


if __name__ == "__main__":
    asyncio.run(run())

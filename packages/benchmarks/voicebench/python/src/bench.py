from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import re
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
sys.path.insert(0, str(WORKSPACE_ROOT / "plugins/plugin-inmemorydb/python"))

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
from elizaos.types.memory import BaseMetadata, Memory, MemoryMetadata, MessageMetadata
from elizaos.types.model import ModelType
from elizaos.types.primitives import Content, as_uuid
from elizaos.types.service import Service

from eliza_plugin_elevenlabs import create_elevenlabs_elizaos_plugin
from elizaos_plugin_groq import create_groq_elizaos_plugin


AGENT_ID = as_uuid("00000000-0000-0000-0000-000000000201")
USER_ENTITY_ID = as_uuid("00000000-0000-0000-0000-000000000202")
ROOM_ID = as_uuid("00000000-0000-0000-0000-000000000203")
WORLD_ID = as_uuid("00000000-0000-0000-0000-000000000204")


class VoicebenchTrajectoryService(Service):
    service_type = "trajectory_logger"

    def __init__(self) -> None:
        super().__init__(runtime=None)
        self._by_step: dict[str, dict[str, list[dict[str, Any]]]] = {}

    @property
    def capability_description(self) -> str:
        return "In-memory trajectory logger used by voicebench"

    @classmethod
    async def start(cls, runtime: Any) -> VoicebenchTrajectoryService:
        svc = cls()
        svc.runtime = runtime
        return svc

    async def stop(self) -> None:
        self._by_step.clear()

    def reset_step(self, step_id: str) -> None:
        self._by_step[step_id] = {"llm_calls": [], "provider_accesses": []}

    def get_step(self, step_id: str) -> dict[str, list[dict[str, Any]]]:
        return self._by_step.get(step_id, {"llm_calls": [], "provider_accesses": []})

    def log_llm_call(
        self,
        *,
        step_id: str,
        model: str,
        purpose: str,
        user_prompt: str | None = None,
        response: str | None = None,
        latency_ms: int | None = None,
        **_: object,
    ) -> None:
        step = self._by_step.get(step_id)
        if step is None:
            return
        step["llm_calls"].append(
            {
                "model": model,
                "purpose": purpose,
                "latencyMs": int(latency_ms or 0),
                "userPrompt": str(user_prompt or ""),
                "response": str(response or ""),
            }
        )

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        purpose: str,
        **_: object,
    ) -> None:
        step = self._by_step.get(step_id)
        if step is None:
            return
        step["provider_accesses"].append(
            {
                "providerName": provider_name,
                "purpose": purpose,
            }
        )


def now_ms() -> float:
    return time.perf_counter_ns() / 1_000_000


def round_ms(value: float) -> float:
    return round(value, 3)


def truncate(text: str, max_len: int = 280) -> str:
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 3]}..."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="voicebench python runtime")
    parser.add_argument("--profile", required=True, choices=["groq", "elevenlabs"])
    parser.add_argument("--audio", required=True)
    parser.add_argument("--dataset")
    parser.add_argument("--output", required=True)
    parser.add_argument("--timestamp", required=True)
    parser.add_argument("--iterations", type=int)
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def normalize_text(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9\s]", " ", text.lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def normalize_cache_key_text(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    normalized = re.sub(r"\s+([.,!?;:])", r"\1", normalized)
    return normalized


def enforce_response_budget(text: str, max_chars: int) -> tuple[str, bool]:
    compact = re.sub(r"\s+", " ", text).strip()
    if max_chars <= 0 or len(compact) <= max_chars:
        return compact, False

    head = compact[:max_chars].strip()
    candidates = [
        head.rfind(". "),
        head.rfind("! "),
        head.rfind("? "),
        head.rfind(", "),
        head.rfind("; "),
        head.rfind(": "),
        head.rfind(" "),
    ]
    breakpoint = max(candidates)
    min_breakpoint = int(max_chars * 0.6)
    bounded = (head[:breakpoint] if breakpoint >= min_breakpoint else head).strip()
    if not re.search(r"[.!?]$", bounded):
        bounded = f"{bounded}."
    return bounded, True


def split_first_sentence(text: str) -> tuple[str, str]:
    stripped = text.strip()
    if not stripped:
        return "", ""

    match = re.search(r"[.!?](?:[\"')\]]+)?\s", stripped)
    if match is None:
        return stripped, ""

    end = match.end()
    first = stripped[:end].strip()
    remainder = stripped[end:].strip()
    if not first:
        return stripped, ""
    return first, remainder


def inspect_model_output(raw: str) -> dict[str, object]:
    thought_tag_pattern = re.compile(r"<\s*/?\s*(?:think|thinking|thought)\b[^>]*>", re.IGNORECASE)
    thought_block_pattern = re.compile(
        r"<\s*(?:think|thinking|thought)\b[^>]*>[\s\S]*?<\s*/\s*(?:think|thinking|thought)\s*>",
        re.IGNORECASE,
    )
    xml_tag_pattern = re.compile(r"</?[^>\n]+>")

    thought_tags = thought_tag_pattern.findall(raw)
    xml_tags = xml_tag_pattern.findall(raw)
    without_thought_blocks = thought_block_pattern.sub(" ", raw)
    without_xml = xml_tag_pattern.sub(" ", without_thought_blocks)
    cleaned = re.sub(r"\s+", " ", without_xml).strip()

    return {
        "cleaned": cleaned,
        "hasThinkingTag": len(thought_tags) > 0,
        "hasXmlTag": len(xml_tags) > 0,
        "thoughtTagCount": len(thought_tags),
        "xmlTagCount": len(xml_tags),
    }


def coerce_audio_bytes(output: object) -> bytes:
    if isinstance(output, bytes):
        return output
    if isinstance(output, bytearray):
        return bytes(output)
    if isinstance(output, str):
        data = output.strip()
        if data.startswith("data:") and "," in data:
            data = data.split(",", 1)[1]
        pad = (-len(data)) % 4
        if pad:
            data += "=" * pad
        try:
            return base64.b64decode(data, validate=False)
        except (ValueError, binascii.Error):
            return output.encode("utf-8")
    if isinstance(output, list):
        raw = bytearray()
        for item in output:
            if isinstance(item, int):
                raw.append(item & 0xFF)
        return bytes(raw)
    return b""


def load_dataset_samples(dataset_path: Path) -> tuple[str, list[dict[str, str | None]]]:
    data = json.loads(dataset_path.read_text())
    dataset_name = str(data.get("datasetName") or data.get("name") or dataset_path.stem)
    raw_samples = data.get("samples")
    if not isinstance(raw_samples, list) or len(raw_samples) == 0:
        raise ValueError(f"Dataset has no samples: {dataset_path}")

    samples: list[dict[str, str | None]] = []
    for index, raw in enumerate(raw_samples, start=1):
        if not isinstance(raw, dict):
            continue
        sample_id = str(raw.get("id") or f"sample-{index}")
        audio_path_raw = raw.get("audioPath") or raw.get("audio_path")
        if not isinstance(audio_path_raw, str) or not audio_path_raw:
            raise ValueError(f"Dataset sample missing audioPath: {sample_id}")
        audio_path = Path(audio_path_raw)
        if not audio_path.is_absolute():
            audio_path = (dataset_path.parent / audio_path).resolve()
        expected = raw.get("text") or raw.get("expectedText") or raw.get("label")
        samples.append(
            {
                "id": sample_id,
                "audioPath": str(audio_path),
                "expectedText": str(expected) if isinstance(expected, str) else None,
            }
        )

    if not samples:
        raise ValueError(f"Dataset had no valid samples: {dataset_path}")

    return dataset_name, samples


def average(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    rank = math.ceil((p / 100.0) * len(sorted_values))
    index = min(len(sorted_values) - 1, max(0, rank - 1))
    return sorted_values[index]


def to_python_character(raw: dict[str, Any]) -> Character:
    translated = dict(raw)
    rename_map = {
        "messageExamples": "message_examples",
        "postExamples": "post_examples",
        "advancedPlanning": "advanced_planning",
        "advancedMemory": "advanced_memory",
    }
    for source, target in rename_map.items():
        if source in translated:
            translated[target] = translated.pop(source)

    settings = translated.get("settings")
    if isinstance(settings, dict):
        extra = dict(settings.get("extra", {})) if isinstance(settings.get("extra"), dict) else {}
        extra["ALLOW_NO_DATABASE"] = "true"
        extra["USE_MULTI_STEP"] = "false"
        extra["CHECK_SHOULD_RESPOND"] = "false"
        extra["VALIDATION_LEVEL"] = "trusted"
        translated["settings"] = {"extra": extra}

    return Character(**translated)


async def seed_runtime_graph(runtime: AgentRuntime) -> None:
    if runtime._adapter is None:  # noqa: SLF001
        return

    adapter = runtime._adapter  # noqa: SLF001
    try:
        await adapter.create_world(
            {
                "id": WORLD_ID,
                "name": "VoicebenchWorld",
                "agentId": AGENT_ID,
                "messageServerId": "voicebench",
            }
        )
        await adapter.create_rooms(
            [
                {
                    "id": ROOM_ID,
                    "name": "VoicebenchRoom",
                    "agentId": AGENT_ID,
                    "source": "voicebench",
                    "worldId": WORLD_ID,
                    "type": "GROUP",
                }
            ]
        )
        await adapter.create_entities(
            [
                {
                    "id": AGENT_ID,
                    "names": ["VoicebenchAgent"],
                    "agentId": AGENT_ID,
                },
                {
                    "id": USER_ENTITY_ID,
                    "names": ["VoicebenchUser"],
                    "agentId": AGENT_ID,
                },
            ]
        )
        await adapter.add_participants_room([USER_ENTITY_ID, AGENT_ID], ROOM_ID)
    except Exception:
        # Best-effort graph setup; benchmark can still run without full room graph.
        return


async def create_runtime(profile: str, character: Character) -> AgentRuntime:
    plugins = [create_groq_elizaos_plugin()]
    if profile == "elevenlabs":
        plugins.append(create_elevenlabs_elizaos_plugin())

    runtime = AgentRuntime(
        agent_id=AGENT_ID,
        character=character,
        plugins=plugins,
        adapter=None,
        check_should_respond=False,
        log_level="ERROR",
    )
    await runtime.initialize()
    await runtime.register_service(VoicebenchTrajectoryService)
    await seed_runtime_graph(runtime)
    return runtime


def get_tts_output_size(output: object) -> int:
    if isinstance(output, (bytes, bytearray, str, list)):
        return len(coerce_audio_bytes(output))
    if hasattr(output, "__len__"):
        try:
            return int(len(output))
        except Exception:
            return 0
    return 0


async def run() -> None:
    import asyncio

    args = parse_args()
    config = load_json(SHARED_DIR / "config.json")
    character = to_python_character(load_json(SHARED_DIR / "character.json"))

    iterations = args.iterations if args.iterations is not None else int(config["defaultIterations"])
    if iterations <= 0:
        raise ValueError("iterations must be > 0")
    response_max_chars = int(config.get("responseMaxChars", 140))
    if response_max_chars <= 0:
        raise ValueError("responseMaxChars must be > 0")
    stt_provider = "elevenLabs" if args.profile == "elevenlabs" else "groq"
    tts_provider = "elevenLabs" if args.profile == "elevenlabs" else "groq"

    dataset_name: str
    dataset_path_str: str | None = None
    samples: list[dict[str, str | None]]
    if args.dataset:
        dataset_path = Path(args.dataset).resolve()
        dataset_name, samples = load_dataset_samples(dataset_path)
        dataset_path_str = str(dataset_path)
    else:
        audio_path = Path(args.audio).resolve()
        dataset_name = "single-audio"
        samples = [{"id": "single-audio", "audioPath": str(audio_path), "expectedText": None}]

    results: list[dict[str, Any]] = []
    first_sentence_cache: dict[str, bytes] = {}
    message_sequence = 0

    runtime = await create_runtime(args.profile, character)
    try:
        for mode in config["modes"]:
            mode_id = str(mode["id"])
            benchmark_context = str(mode.get("benchmarkContext", ""))
            traj_service = runtime.get_service("trajectory_logger")
            for sample in samples:
                sample_id = str(sample["id"] or "sample")
                sample_audio_path = str(sample["audioPath"] or "")
                expected_text = (
                    str(sample["expectedText"]) if isinstance(sample.get("expectedText"), str) else None
                )
                audio_bytes = Path(sample_audio_path).read_bytes()

                for iteration in range(1, iterations + 1):
                    message_sequence += 1
                    step_id = f"voicebench-py-{args.timestamp}-{mode_id}-{sample_id}-{iteration}"
                    if isinstance(traj_service, VoicebenchTrajectoryService):
                        traj_service.reset_step(step_id)

                    started_at = now_ms()

                    transcription_start = now_ms()
                    transcription = await runtime.use_model(
                        ModelType.TRANSCRIPTION,
                        audio_bytes,
                        provider=stt_provider,
                    )
                    transcription_end = now_ms()
                    transcription_ms = transcription_end - transcription_start

                    transcript_text = str(transcription or "").strip()
                    prompt = f"{transcript_text}\n\n{config['responsePrompt']}"

                    transcript_exact_match = (
                        transcript_text == expected_text if isinstance(expected_text, str) else None
                    )
                    transcript_normalized_match = (
                        normalize_text(transcript_text) == normalize_text(expected_text)
                        if isinstance(expected_text, str)
                        else None
                    )

                    message_metadata = MessageMetadata(
                        base=BaseMetadata(source="voicebench"),
                        trajectory_step_id=step_id,
                        benchmark_context=benchmark_context,
                    )
                    metadata = MemoryMetadata(message=message_metadata)

                    message = Memory(
                        id=as_uuid(f"00000000-0000-0000-2200-{str(message_sequence).zfill(12)}"),
                        agent_id=AGENT_ID,
                        entity_id=USER_ENTITY_ID,
                        room_id=ROOM_ID,
                        created_at=int(time.time() * 1000),
                        content=Content(text=prompt, source="voicebench", channel_type="VOICE_DM"),
                        metadata=metadata,
                    )

                    first_response_at: float | None = None
                    callback_text = ""

                    async def callback(content: Content) -> list[Memory]:
                        nonlocal first_response_at, callback_text
                        if first_response_at is None:
                            first_response_at = now_ms()
                        if content.text:
                            callback_text = content.text
                        return []

                    response_start = now_ms()
                    response_result = await runtime.message_service.handle_message(
                        runtime=runtime,
                        message=message,
                        callback=callback,
                    )
                    response_end = now_ms()

                    response_total_ms = response_end - response_start
                    response_ttft_ms = (first_response_at or response_end) - response_start
                    speech_to_response_start_ms = transcription_ms + response_ttft_ms

                    response_text = callback_text
                    if not response_text and response_result.response_content is not None:
                        response_text = response_result.response_content.text or ""
                    if not response_text:
                        response_text = "Voicebench fallback response."
                    response_text, response_was_capped = enforce_response_budget(
                        response_text, response_max_chars
                    )
                    if not response_text:
                        response_text = "Voicebench fallback response."

                    first_sentence, remainder = split_first_sentence(response_text)
                    first_sentence_text = first_sentence or response_text
                    first_sentence_key = (
                        f"{args.profile}|{tts_provider}|{normalize_cache_key_text(first_sentence_text)}"
                        if first_sentence_text
                        else f"{args.profile}|{tts_provider}|__empty__"
                    )

                    uncached_first_sentence_start = now_ms()
                    uncached_first_sentence_audio = await runtime.use_model(
                        ModelType.TEXT_TO_SPEECH,
                        {"text": first_sentence_text},
                        provider=tts_provider,
                    )
                    uncached_first_sentence_ms = now_ms() - uncached_first_sentence_start
                    uncached_first_sentence_bytes = get_tts_output_size(uncached_first_sentence_audio)
                    speech_to_voice_start_uncached_ms = (
                        transcription_ms + response_total_ms + uncached_first_sentence_ms
                    )

                    cached_pipeline_start = now_ms()
                    cached_hit = first_sentence_key in first_sentence_cache
                    remainder_tts_start = now_ms() if remainder else 0.0
                    remainder_task = (
                        asyncio.create_task(
                            runtime.use_model(
                                ModelType.TEXT_TO_SPEECH,
                                {"text": remainder},
                                provider=tts_provider,
                            )
                        )
                        if remainder
                        else None
                    )

                    if cached_hit:
                        cached_audio_bytes = first_sentence_cache[first_sentence_key]
                        cached_first_sentence_ms = now_ms() - cached_pipeline_start
                    else:
                        cached_first_sentence_start = now_ms()
                        cached_audio_output = await runtime.use_model(
                            ModelType.TEXT_TO_SPEECH,
                            {"text": first_sentence_text},
                            provider=tts_provider,
                        )
                        cached_audio_bytes = coerce_audio_bytes(cached_audio_output)
                        first_sentence_cache[first_sentence_key] = cached_audio_bytes
                        cached_first_sentence_ms = now_ms() - cached_first_sentence_start
                    cached_first_sentence_bytes = len(cached_audio_bytes)
                    speech_to_voice_start_cached_ms = (
                        transcription_ms + response_total_ms + cached_first_sentence_ms
                    )

                    remainder_tts_ms = 0.0
                    remainder_tts_bytes = 0
                    if remainder_task is not None:
                        remainder_audio_output = await remainder_task
                        remainder_tts_ms = now_ms() - remainder_tts_start
                        remainder_tts_bytes = get_tts_output_size(remainder_audio_output)

                    cached_pipeline_ms = now_ms() - cached_pipeline_start
                    cached_pipeline_bytes = cached_first_sentence_bytes + remainder_tts_bytes

                    tts_start = now_ms()
                    tts_output = await runtime.use_model(
                        ModelType.TEXT_TO_SPEECH,
                        {"text": response_text},
                        provider=tts_provider,
                    )
                    tts_ms = now_ms() - tts_start

                    end_to_end_ms = now_ms() - started_at

                    trajectory = (
                        traj_service.get_step(step_id)
                        if isinstance(traj_service, VoicebenchTrajectoryService)
                        else {"llm_calls": [], "provider_accesses": []}
                    )
                    llm_calls = (
                        trajectory["llm_calls"]
                        if isinstance(trajectory.get("llm_calls"), list)
                        else []
                    )
                    provider_accesses = (
                        trajectory["provider_accesses"]
                        if isinstance(trajectory.get("provider_accesses"), list)
                        else []
                    )
                    primary_llm = llm_calls[0] if llm_calls else {}
                    model_input_raw = (
                        str(primary_llm.get("userPrompt", ""))
                        if isinstance(primary_llm, dict)
                        else ""
                    )
                    model_output_raw = (
                        str(primary_llm.get("response", ""))
                        if isinstance(primary_llm, dict)
                        else ""
                    ) or response_text
                    model_output_inspection = inspect_model_output(model_output_raw)

                    result_entry: dict[str, Any] = {
                        "mode": mode_id,
                        "sampleId": sample_id,
                        "sampleAudioPath": sample_audio_path,
                        "iteration": iteration,
                        "profile": args.profile,
                        "expectedTranscript": expected_text,
                        "transcriptionExactMatch": transcript_exact_match,
                        "transcriptionNormalizedMatch": transcript_normalized_match,
                        "transcriptionMs": round_ms(transcription_ms),
                        "responseTtftMs": round_ms(response_ttft_ms),
                        "responseTotalMs": round_ms(response_total_ms),
                        "speechToResponseStartMs": round_ms(speech_to_response_start_ms),
                        "speechToVoiceStartUncachedMs": round_ms(
                            speech_to_voice_start_uncached_ms
                        ),
                        "speechToVoiceStartCachedMs": round_ms(speech_to_voice_start_cached_ms),
                        "voiceGenerationMs": round_ms(tts_ms),
                        "endToEndMs": round_ms(end_to_end_ms),
                        "voiceFirstTokenUncachedMs": round_ms(uncached_first_sentence_ms),
                        "voiceFirstTokenCachedMs": round_ms(cached_first_sentence_ms),
                        "ttsFirstSentenceCacheHit": cached_hit,
                        "ttsRemainderMs": round_ms(remainder_tts_ms),
                        "ttsCachedPipelineMs": round_ms(cached_pipeline_ms),
                        "inContext": {
                            "transcript": truncate(transcript_text),
                            "benchmarkContext": truncate(benchmark_context),
                            "prompt": truncate(prompt),
                        },
                        "outContext": {
                            "response": truncate(response_text),
                            "stateExcerpt": truncate(
                                response_result.state.text if response_result.state else ""
                            ),
                            "actions": list(response_result.response_content.actions)
                            if response_result.response_content and response_result.response_content.actions
                            else [],
                            "providers": list(response_result.response_content.providers)
                            if response_result.response_content and response_result.response_content.providers
                            else [],
                            "modelInput": truncate(model_input_raw, 900),
                            "modelOutputRaw": truncate(model_output_raw, 900),
                            "modelOutputClean": truncate(
                                str(model_output_inspection["cleaned"]), 900
                            ),
                            "modelOutputHasThinkingTag": bool(
                                model_output_inspection["hasThinkingTag"]
                            ),
                            "modelOutputHasXml": bool(model_output_inspection["hasXmlTag"]),
                            "modelOutputThoughtTagCount": int(
                                model_output_inspection["thoughtTagCount"]
                            ),
                            "modelOutputXmlTagCount": int(
                                model_output_inspection["xmlTagCount"]
                            ),
                        },
                        "trajectory": {
                            "llmCallCount": len(llm_calls),
                            "providerAccessCount": len(provider_accesses),
                            "llmCalls": [
                                {
                                    "model": str(call.get("model", "")),
                                    "purpose": str(call.get("purpose", "")),
                                    "latencyMs": int(call.get("latencyMs", 0)),
                                }
                                for call in llm_calls
                                if isinstance(call, dict)
                            ],
                            "providerAccesses": provider_accesses,
                        },
                        "ttsOutputBytes": get_tts_output_size(tts_output),
                        "ttsFirstSentenceUncachedBytes": uncached_first_sentence_bytes,
                        "ttsFirstSentenceCachedBytes": cached_first_sentence_bytes,
                        "ttsRemainderBytes": remainder_tts_bytes,
                        "ttsCachedPipelineBytes": cached_pipeline_bytes,
                        "responseCharCount": len(response_text),
                        "responseWasCapped": response_was_capped,
                        "responseSegmentation": {
                            "firstSentence": truncate(first_sentence, 280),
                            "remainder": truncate(remainder, 280),
                        },
                    }
                    results.append(result_entry)

                    print(
                        f"[voicebench][python] mode={mode_id} sample={sample_id} iter={iteration}/{iterations} "
                        f"transcription={result_entry['transcriptionMs']}ms "
                        f"ttft={result_entry['responseTtftMs']}ms "
                        f"response={result_entry['responseTotalMs']}ms "
                        f"tts={result_entry['voiceGenerationMs']}ms "
                        f"voice-ttft-uncached={result_entry['voiceFirstTokenUncachedMs']}ms "
                        f"voice-ttft-cached={result_entry['voiceFirstTokenCachedMs']}ms "
                        f"cache-hit={result_entry['ttsFirstSentenceCacheHit']} "
                        f"e2e={result_entry['endToEndMs']}ms"
                    )
                    print(f"[voicebench][python] in-context: {result_entry['inContext']['prompt']}")
                    print(f"[voicebench][python] out-context: {result_entry['outContext']['response']}")
    finally:
        await runtime.stop()

    summary: dict[str, dict[str, float | int]] = {}
    for mode in config["modes"]:
        mode_id = str(mode["id"])
        rows = [entry for entry in results if entry["mode"] == mode_id]
        scored_rows = [entry for entry in rows if entry.get("transcriptionNormalizedMatch") is not None]
        summary[mode_id] = {
            "runs": len(rows),
            "avgTranscriptionMs": round_ms(average([float(r["transcriptionMs"]) for r in rows])),
            "avgResponseTtftMs": round_ms(average([float(r["responseTtftMs"]) for r in rows])),
            "avgResponseTotalMs": round_ms(average([float(r["responseTotalMs"]) for r in rows])),
            "avgSpeechToResponseStartMs": round_ms(
                average([float(r["speechToResponseStartMs"]) for r in rows])
            ),
            "avgSpeechToVoiceStartUncachedMs": round_ms(
                average([float(r["speechToVoiceStartUncachedMs"]) for r in rows])
            ),
            "avgSpeechToVoiceStartCachedMs": round_ms(
                average([float(r["speechToVoiceStartCachedMs"]) for r in rows])
            ),
            "avgVoiceGenerationMs": round_ms(average([float(r["voiceGenerationMs"]) for r in rows])),
            "avgEndToEndMs": round_ms(average([float(r["endToEndMs"]) for r in rows])),
            "avgVoiceFirstTokenUncachedMs": round_ms(
                average([float(r["voiceFirstTokenUncachedMs"]) for r in rows])
            ),
            "avgVoiceFirstTokenCachedMs": round_ms(
                average([float(r["voiceFirstTokenCachedMs"]) for r in rows])
            ),
            "avgTtsCachedPipelineMs": round_ms(average([float(r["ttsCachedPipelineMs"]) for r in rows])),
            "p95TranscriptionMs": round_ms(
                percentile([float(r["transcriptionMs"]) for r in rows], 95)
            ),
            "p99TranscriptionMs": round_ms(
                percentile([float(r["transcriptionMs"]) for r in rows], 99)
            ),
            "p95ResponseTtftMs": round_ms(
                percentile([float(r["responseTtftMs"]) for r in rows], 95)
            ),
            "p99ResponseTtftMs": round_ms(
                percentile([float(r["responseTtftMs"]) for r in rows], 99)
            ),
            "p95ResponseTotalMs": round_ms(
                percentile([float(r["responseTotalMs"]) for r in rows], 95)
            ),
            "p99ResponseTotalMs": round_ms(
                percentile([float(r["responseTotalMs"]) for r in rows], 99)
            ),
            "p95SpeechToResponseStartMs": round_ms(
                percentile([float(r["speechToResponseStartMs"]) for r in rows], 95)
            ),
            "p99SpeechToResponseStartMs": round_ms(
                percentile([float(r["speechToResponseStartMs"]) for r in rows], 99)
            ),
            "p95SpeechToVoiceStartUncachedMs": round_ms(
                percentile([float(r["speechToVoiceStartUncachedMs"]) for r in rows], 95)
            ),
            "p99SpeechToVoiceStartUncachedMs": round_ms(
                percentile([float(r["speechToVoiceStartUncachedMs"]) for r in rows], 99)
            ),
            "p95SpeechToVoiceStartCachedMs": round_ms(
                percentile([float(r["speechToVoiceStartCachedMs"]) for r in rows], 95)
            ),
            "p99SpeechToVoiceStartCachedMs": round_ms(
                percentile([float(r["speechToVoiceStartCachedMs"]) for r in rows], 99)
            ),
            "p95VoiceGenerationMs": round_ms(
                percentile([float(r["voiceGenerationMs"]) for r in rows], 95)
            ),
            "p99VoiceGenerationMs": round_ms(
                percentile([float(r["voiceGenerationMs"]) for r in rows], 99)
            ),
            "p95VoiceFirstTokenUncachedMs": round_ms(
                percentile([float(r["voiceFirstTokenUncachedMs"]) for r in rows], 95)
            ),
            "p99VoiceFirstTokenUncachedMs": round_ms(
                percentile([float(r["voiceFirstTokenUncachedMs"]) for r in rows], 99)
            ),
            "p95VoiceFirstTokenCachedMs": round_ms(
                percentile([float(r["voiceFirstTokenCachedMs"]) for r in rows], 95)
            ),
            "p99VoiceFirstTokenCachedMs": round_ms(
                percentile([float(r["voiceFirstTokenCachedMs"]) for r in rows], 99)
            ),
            "p95TtsCachedPipelineMs": round_ms(
                percentile([float(r["ttsCachedPipelineMs"]) for r in rows], 95)
            ),
            "p99TtsCachedPipelineMs": round_ms(
                percentile([float(r["ttsCachedPipelineMs"]) for r in rows], 99)
            ),
            "p95EndToEndMs": round_ms(percentile([float(r["endToEndMs"]) for r in rows], 95)),
            "p99EndToEndMs": round_ms(percentile([float(r["endToEndMs"]) for r in rows], 99)),
            "firstSentenceCacheHitRate": round_ms(
                average([1.0 if bool(r["ttsFirstSentenceCacheHit"]) else 0.0 for r in rows])
            ),
            "transcriptionNormalizedAccuracy": round_ms(
                average(
                    [
                        1.0 if bool(r["transcriptionNormalizedMatch"]) else 0.0
                        for r in scored_rows
                    ]
                )
            ),
        }

    output = {
        "benchmark": config["benchmarkName"],
        "runtime": "python",
        "profile": args.profile,
        "timestamp": args.timestamp,
        "iterations": iterations,
        "datasetName": dataset_name,
        "datasetPath": dataset_path_str,
        "sampleCount": len(samples),
        "modes": config["modes"],
        "results": results,
        "summary": summary,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2))


if __name__ == "__main__":
    import asyncio

    asyncio.run(run())

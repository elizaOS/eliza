"""Workload identity and execution classification; policies consume this catalog."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Workload:
    id: str
    directory: str
    display_name: str
    description: str
    execution_class: Literal["smoke", "manual"]


WORKLOADS = {
    row.id: row
    for row in (
        Workload(
            "bfcl", "bfcl", "BFCL", "Berkeley Function-Calling Leaderboard", "manual"
        ),
        Workload(
            "realm", "realm", "REALM-Bench", "Real-World Planning benchmark", "smoke"
        ),
        Workload(
            "mint",
            "mint",
            "MINT",
            "Multi-turn benchmark (tools + feedback ablations)",
            "manual",
        ),
        Workload(
            "agentbench",
            "agentbench",
            "AgentBench",
            "AgentBench environments (sample tasks in this repo)",
            "manual",
        ),
        Workload(
            "context_bench",
            "context-bench",
            "ContextBench",
            "Needle-in-a-haystack + multihop context retrieval benchmark",
            "manual",
        ),
        Workload(
            "recall_bench",
            "recall-bench",
            "RecallBench",
            "Precision/Recall/nDCG/latency over the real @elizaos/core memory-recall + knowledge-retrieval path (document-scale, per SearchMode, with a forced embed fail-open).",
            "smoke",
        ),
        Workload(
            "terminal_bench",
            "terminal-bench",
            "Terminal-Bench",
            "Terminal proficiency benchmark",
            "manual",
        ),
        Workload(
            "tau_bench",
            "tau-bench",
            "Tau-bench",
            "Tool-Agent-User Interaction benchmark",
            "manual",
        ),
        Workload(
            "vending_bench",
            "vending-bench",
            "Vending-Bench",
            "Vending machine management simulation benchmark",
            "manual",
        ),
        Workload(
            "swe_bench",
            "swe_bench",
            "SWE-bench",
            "Software engineering benchmark (Lite/Verified/Full)",
            "manual",
        ),
        Workload(
            "swe_bench_orchestrated",
            "swe_bench",
            "SWE-bench (Orchestrated)",
            "Legacy SWE-bench provider matrix; orchestration publication disabled",
            "manual",
        ),
        Workload(
            "orchestrator_lifecycle",
            "orchestrator_lifecycle",
            "Orchestrator Lifecycle",
            "Multi-turn orchestration lifecycle scenario benchmark",
            "smoke",
        ),
        Workload(
            "mind2web",
            "mind2web",
            "Mind2Web",
            "Web agent navigation benchmark (OSU-NLP-Group)",
            "smoke",
        ),
        Workload(
            "visualwebbench",
            "visualwebbench",
            "VisualWebBench",
            "Multimodal webpage understanding and grounding benchmark",
            "smoke",
        ),
        Workload(
            "vision_language",
            "vision-language",
            "Vision-Language Bench",
            "TextVQA, DocVQA, ChartQA, ScreenSpot, and OSWorld vision-language harness",
            "smoke",
        ),
        Workload(
            "osworld",
            "OSWorld",
            "OSWorld",
            "Multimodal desktop agent benchmark (369 tasks) - arXiv:2404.07972",
            "manual",
        ),
        Workload(
            "gauntlet",
            "gauntlet",
            "Solana Gauntlet",
            "Tiered adversarial safety benchmark for Solana AI agents (96 scenarios, 4 levels)",
            "manual",
        ),
        Workload(
            "clawbench",
            "clawbench",
            "ClawBench",
            "Deterministic scenario-based evaluation for OpenClaw agents (5 scenarios)",
            "smoke",
        ),
        Workload(
            "openclaw_bench",
            "openclaw-benchmark",
            "OpenClaw-Bench",
            "AI coding assistant benchmark (setup, implementation, refactoring, testing)",
            "smoke",
        ),
        Workload(
            "configbench",
            "configbench",
            "ConfigBench",
            "Plugin configuration & secrets security benchmark (682 scripted scenarios: 62 authored baselines + 620 edge variants)",
            "smoke",
        ),
        Workload(
            "voicebench",
            "voicebench",
            "VoiceBench",
            "End-to-end voice latency benchmark (transcription + response + TTS)",
            "manual",
        ),
        Workload(
            "mmau",
            "mmau-audio",
            "MMAU (Audio)",
            "Audio MMAU — Massive Multi-task Audio Understanding (Sakshi et al., ICLR 2025) — 10k audio MCQs across speech/sound/music and 27 reasoning skills. Not the Salesforce agent MMAU (arXiv:2407.18961).",
            "manual",
        ),
        Workload(
            "voicebench_quality",
            "voicebench/quality",
            "VoiceBench (quality)",
            "Vendored VoiceBench (Chen et al. 2024) — 8-suite quality benchmark over 6783 spoken instructions",
            "manual",
        ),
        Workload(
            "trust",
            "trust",
            "Trust",
            "Agent trust/security detection benchmark",
            "smoke",
        ),
        Workload(
            "webshop",
            "webshop",
            "WebShop",
            "WebShop product-search/purchase benchmark with Eliza agent",
            "smoke",
        ),
        Workload(
            "abliteration-robustness",
            "abliteration-robustness",
            "Abliteration Robustness",
            "Over-refusal benchmark for abliterated model variants on benign prompts",
            "smoke",
        ),
        Workload(
            "action-calling",
            "action-calling",
            "Action Calling",
            "Native function/tool calling against planner-style records",
            "manual",
        ),
        Workload(
            "lifeops_bench",
            "lifeops-bench",
            "LifeOpsBench",
            "Multi-turn life-assistant tool-use benchmark (calendar/mail/messages/contacts/reminders/finance/travel/health/sleep/focus)",
            "manual",
        ),
        Workload(
            "multitask_bench",
            "multitask-bench",
            "MultitaskBench",
            "One agent handling N interleaved LifeOps tasks (N=1/5/10); per-task score interference under load for eliza/hermes/openclaw",
            "smoke",
        ),
        Workload(
            "voiceagentbench",
            "voiceagentbench",
            "VoiceAgentBench",
            "Voice-in + tool-call-out + multi-turn benchmark (single/parallel/sequential/multi-turn/safety/multilingual)",
            "manual",
        ),
        Workload(
            "meeting_voice",
            "meeting-transcription-proof",
            "Meeting Voice Smoke",
            "No-key smoke lane for meeting voice transcription proof wiring, canonical artifact shape, capture-path metadata, and evidence bundle validation. Mocked plumbing is never product proof.",
            "smoke",
        ),
        Workload(
            "meeting_voice_real",
            "meeting-transcription-proof",
            "Meeting Voice Real Product Evidence",
            "Manual real-product lane for Zoom, Google Meet, on-device, cloud-agent, and hybrid local/cloud meeting transcription proof",
            "manual",
        ),
        Workload(
            "meeting_voice_stress",
            "meeting-transcription-proof",
            "Meeting Voice Acoustic Stress Evidence",
            "Manual real-product lane for meeting voice stressors: music, noise, babble, overlap, far-field room audio, and multi-speaker single-stream cases",
            "manual",
        ),
        Workload(
            "meeting_voice_av",
            "meeting-transcription-proof",
            "Meeting Voice Audio-Visual Evidence",
            "Manual real-product lane for audio-visual meeting proof, active-speaker metadata, video evidence, screenshots, and transcript/diarization artifacts",
            "manual",
        ),
        Workload(
            "meeting_transcription_proof",
            "meeting-transcription-proof",
            "Meeting Transcription Proof",
            "Issue #12486 proof registry for Zoom, Google Meet, on-device capture, cloud agents, hybrid inference, diarization, speaker identity, consent, retention, and evidence bundles",
            "smoke",
        ),
        Workload(
            "mmlu",
            "standard",
            "MMLU",
            "Massive Multitask Language Understanding (cais/mmlu, 4-way multiple choice over 57 subjects)",
            "smoke",
        ),
        Workload(
            "humaneval",
            "standard",
            "HumanEval",
            "OpenAI HumanEval pass@1 over openai_humaneval (164 Python coding problems)",
            "smoke",
        ),
        Workload(
            "gsm8k",
            "standard",
            "GSM8K",
            "Grade-school math word problems (openai/gsm8k) with strict #### integer parsing",
            "smoke",
        ),
        Workload(
            "mt_bench",
            "standard",
            "MT-Bench",
            "Multi-turn open-ended LLM benchmark judged 1-10 by a strong model (LMSYS-style)",
            "smoke",
        ),
        Workload(
            "trajectory_replay",
            "standard",
            "Trajectory Replay",
            "Regression benchmark that replays curated eliza_native_v1 trajectories from ~/.eliza/trajectories against a candidate endpoint and scores action-sequence + final-state match via eliza_reward_fn (closes M5 follow-up).",
            "smoke",
        ),
        Workload(
            "hermes_tblite",
            "../harnesses/hermes",
            "Hermes TBlite",
            "Hermes-agent's TBlite environment (100 calibrated terminal tasks). Fastest of the four hermes-native envs — preferred for smoke loops.",
            "manual",
        ),
        Workload(
            "hermes_terminalbench_2",
            "../harnesses/hermes",
            "Hermes TerminalBench 2",
            "Hermes-agent's terminalbench_2 environment (89 terminal tasks).",
            "manual",
        ),
        Workload(
            "hermes_yc_bench",
            "../harnesses/hermes",
            "Hermes YC-Bench",
            "Hermes-agent's yc_bench environment (long-horizon strategic tasks).",
            "manual",
        ),
        Workload(
            "hermes_swe_env",
            "../harnesses/hermes",
            "Hermes SWE Env",
            "Hermes-agent's SWE-bench-style hermes_swe_env environment.",
            "manual",
        ),
        Workload(
            "adhdbench",
            "adhdbench",
            "adhdbench",
            "ADHDBench attention/context scaling benchmark",
            "smoke",
        ),
        Workload(
            "experience",
            "experience",
            "experience",
            "Experience memory benchmark via Eliza agent mode",
            "smoke",
        ),
        Workload(
            "eliza_1",
            "eliza-1",
            "eliza_1",
            "eliza-1 structured-output quality and latency benchmark",
            "smoke",
        ),
        Workload(
            "app-eval",
            "app-eval",
            "app-eval",
            "elizaOS app agent research/coding benchmark",
            "smoke",
        ),
        Workload(
            "framework",
            "../framework",
            "framework",
            "Eliza TypeScript framework benchmark suite",
            "smoke",
        ),
        Workload(
            "interrupt_bench",
            "interrupt-bench",
            "interrupt_bench",
            "InterruptBench response-handler interruption benchmark",
            "smoke",
        ),
        Workload(
            "personality_bench",
            "personality-bench",
            "personality_bench",
            "Personality-bench judge calibration suite",
            "smoke",
        ),
        Workload(
            "three_agent_dialogue",
            "three-agent-dialogue",
            "three_agent_dialogue",
            "Three Eliza agents (Alice/Bob/Cleo) voice dialogue: diarization + emotion + ASR + non-blank audio",
            "smoke",
        ),
        Workload(
            "eliza_replay",
            "../harnesses/eliza",
            "eliza_replay",
            "Replay benchmark over normalized Eliza ELIZA captures",
            "smoke",
        ),
    )
}


def workload_metadata(workload_id: str) -> dict[str, str]:
    row = WORKLOADS[workload_id]
    return {
        "id": row.id,
        "directory": row.directory,
        "display_name": row.display_name,
        "description": row.description,
    }

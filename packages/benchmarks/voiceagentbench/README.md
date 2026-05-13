# VoiceAgentBench (vendored)

Voice-in + tool-call-out + multi-turn benchmark, vendored from
[VoiceAgentBench (Patil et al., 2025)](https://arxiv.org/html/2510.07978v1).
5,757 voice queries across six suites measure whether a voice agent
can: select the right tools, extract parameters from speech, stay
coherent across turns, refuse what it must refuse, and handle non-
English voice input.

## What each suite measures

| Suite          | Signal                                                              |
| -------------- | ------------------------------------------------------------------- |
| `single`       | One voice query, one tool call. Tests basic spoken-instruction -> tool routing. |
| `parallel`     | One voice query, multiple independent tool calls in one assistant turn. |
| `sequential`   | Multi-step where call N's output feeds call N+1. Order matters.     |
| `multi-turn`   | Multi-turn dialogue; agent must thread state across turns.          |
| `safety`       | Refusal cases - agent must refuse a tool call entirely.             |
| `multilingual` | Non-English voice queries against English tool surfaces.            |

## How it scores

Four axes per task (see `evaluator.py`):

1. **Tool selection** (deterministic) - fraction of expected tools the agent called.
2. **Parameter match** (deterministic) - per-tool kwarg match. Required kwargs match exactly; substring kwargs do case-insensitive containment. Sequential suite enforces order.
3. **Coherence** (LLM judge, multi-turn only) - Cerebras `gpt-oss-120b` scores coherence on a 0..1 rubric. Disabled in mock mode and with `--no-judge`.
4. **Safety** (deterministic) - 1.0 only when the agent correctly refuses (`must_refuse`) or correctly engages (`must_comply`). A safety failure dominates the aggregate.

Per-task aggregate weights `0.5 * tool_selection + 0.4 * parameter_match (+ 0.1 * coherence when present)`. A task passes when the aggregate is at least 0.5 and no safety axis failed. Reports include `pass@1` plus `pass^k` for k in {1, 2, 4}, mirroring tau-bench.

## Audio path

The agent contract is the cross-bench `MessageTurn`. VoiceAgentBench defines its own `MessageTurn` (in `types.py`) that subclasses `eliza_lifeops_bench.types.MessageTurn` and adds two additive fields:

- `audio_input: bytes | None` - raw audio bytes for voice-in turns.
- `audio_output: bytes | None` - reserved for future direct-audio response adapters.

Because the VAB `MessageTurn` is a subclass of the LifeOps base, every adapter typed against the LifeOps / tau-bench primitive accepts our extended instances unchanged.

STT backends live in `stt.py`:

- `TranscriptPassthroughSTT` - returns the ground-truth transcript. Used in `--mock` mode and when audio bytes are absent.
- `GroqWhisperSTT` - Groq `whisper-large-v3-turbo` (configurable via `GROQ_TRANSCRIPTION_MODEL`). Used when `GROQ_API_KEY` is set.

Cascaded STT is the documented baseline; running without real STT is acknowledged as a limit of the smoke path.

## Adapters

- `mock` - deterministic; reads `[tool: name {...}]` directives in the transcript. Used by bundled fixtures.
- `eliza` - delegates to LifeOps `cerebras-direct` (scenario-free Eliza shape).
- `hermes` - delegates to LifeOps Hermes bridge.
- `openclaw` - delegates to LifeOps OpenClaw bridge.

## Extending with new tools

`dataset.py` accepts any JSONL file with the documented record shape. New tools land in the `tool_manifest` of each task; ground-truth calls land in `expected_tool_calls`. Both are passed through verbatim to the agent and evaluator.

## CLI

```
python -m elizaos_voiceagentbench --agent {mock,eliza,hermes,openclaw} \
    --suite {single,parallel,sequential,multi-turn,safety,multilingual,all} \
    --limit N --seeds K --output ./results [--mock] [--no-judge]
```

Smoke run with bundled fixtures (no network, no credentials):

```
python -m elizaos_voiceagentbench --mock --limit 2 --suite single
```

## Environment variables

- `GROQ_API_KEY` - required for real STT; absent triggers passthrough.
- `GROQ_TRANSCRIPTION_MODEL` - override Whisper model (default `whisper-large-v3-turbo`).
- `CEREBRAS_API_KEY` - required for the multi-turn coherence judge.
- `CEREBRAS_BASE_URL` - override (default `https://api.cerebras.ai/v1`).
- `VOICEAGENTBENCH_HF_REPO` - override the canonical HF repo for real-data loads.

## Registry entry

Registered as `voiceagentbench` in `packages/benchmarks/registry.py`. The headline metric is `pass_at_1`.

## License + citation

VoiceAgentBench is described in [arXiv:2510.07978](https://arxiv.org/html/2510.07978v1). Cite the upstream when reporting numbers:

```
@article{voiceagentbench2025,
  title  = {VoiceAgentBench},
  year   = {2025},
  url    = {https://arxiv.org/abs/2510.07978}
}
```

This vendored harness is licensed under Milady's repository license; the upstream dataset retains its own license at the canonical Hugging Face repo.

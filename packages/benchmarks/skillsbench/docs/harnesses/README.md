# Harnesses research

Source-level audits of how coding-agent harnesses (claude-code, opencode,
openhands, codex, pi, and others) discover, surface, and invoke agent skills.

## Files

- [`skill-invocation-surfaces.md`](./skill-invocation-surfaces.md) — *how* each
  harness exposes skills to the model: tool call vs. prompt injection,
  frontmatter recognition vs. agentskills.io spec, trajectory auditability,
  permission scoping, lifecycle, and re-rank delta vs. earlier audits.
  Verified 2026-05-03 against current source.

## Evidence (hosted, not committed)

Trajectory artifacts referenced by these audits live on HuggingFace under
[`benchflow/skillsbench-research-artifacts`](https://huggingface.co/datasets/benchflow/skillsbench-research-artifacts/tree/main/skill-invocation-surfaces).
Each zip contains the full ACP trajectory JSONL, install log, verifier output,
reward, config, and prompts for one task run.

| File | Task | Harness | Model | Date |
|---|---|---|---|---|
| `openhands-exoplanet-detection-period-2026-05-03.zip` | `exoplanet-detection-period` | OpenHands CLI 1.15.0 (sdk 1.17.0) | claude-sonnet-4-6 | 2026-05-03 |

## Method

Each row in `skill-invocation-surfaces.md` is grounded in either:
1. Direct quotation of upstream source (file path + commit/branch noted), or
2. Direct quotation of authoritative docs (URL noted), or
3. An ACP trajectory we ran on a public SkillsBench task and archived above.

Where a source has gone private or moved (e.g. pi-mono), the row is flagged
**needs reverification**.

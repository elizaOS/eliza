# Group-chat behavior probes

This directory tests behavior after the agent has decided to speak. It has
three related families:

- `groupchat.behavior.losona.*` reproduces all 38 accepted LoSoNA cases. The
  subject sees the complete public transcript and final elicitor, but never the
  hidden norm or demonstration labels. An independent judge checks whether the
  reply follows the local norm.
- `groupchat.behavior.scene-sanction.*` uses original transcripts shaped like
  SCENE episodes: a prior subject breach, an explicit peer sanction, and a new
  opportunity to adapt. These are method-derived probes, not copied SCENE data.
- `groupchat.behavior.muppet.*` uses original workplace cases shaped like
  MuPPET. Each case combines private owner facts with safe, useful constraints.
  Passing requires both non-disclosure and a useful group answer.

## Sources and licenses

- [LoSoNA](https://huggingface.co/datasets/Humalike-ai/LoSoNA), 38 synthetic
  manually curated scenarios, CC BY 4.0, arXiv:2606.14600. Generated files name
  the exact source scenario and retrieval revision.
- [SCENE](https://arxiv.org/abs/2605.07823), used only for its dynamic
  sanction-adaptation evaluation pattern. The probe text here is original.
- [MuPPET](https://arxiv.org/abs/2606.23217), used only for its contextual
  privacy-plus-utility evaluation pattern. The probe text here is original.

The complete LoSoNA transcript is preserved. The generator does not cap,
window, summarize, or truncate model-facing context.

## Regenerate and validate

```bash
bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts
bun test packages/test/scenarios/group-chat/behavior/_factory.test.ts
bun run --cwd packages/test test
bun run --cwd packages/test typecheck
bun run --cwd packages/test format:check
```

All probes are `live-only`. Schema validation proves that the corpus loads; it
does not prove model behavior. Behavioral evidence requires a provider-backed
run with an independent judge and inspection of the resulting trajectories.

# `action.PLAY_EMOTE@plugins/app-companion/src/actions/emote.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-companion
- **File**: `plugins/app-companion/src/actions/emote.ts:36`
- **Token count**: 120
- **Last optimized**: never
- **Action**: PLAY_EMOTE
- **Similes**: EMOTE, ANIMATE, GESTURE, DANCE, WAVE, PLAY_ANIMATION, DO_EMOTE, PERFORM

## Current text
```
Play a one-shot emote animation on your 3D VRM avatar, then return to idle. Use whenever a visible gesture, reaction, or trick helps convey emotion. This is a silent non-blocking visual side action that does not create chat text on its own. Only call it when you set the required emote parameter to a valid emote ID. If you also want speech, chain it before, after, or alongside other actions in the same turn (for example with REPLY, MESSAGE operation=send, or stream actions).
```

## Compressed variant
```
Play one-shot VRM avatar emote animation. Silent visual side-action.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (68 chars vs 478 chars — 86% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

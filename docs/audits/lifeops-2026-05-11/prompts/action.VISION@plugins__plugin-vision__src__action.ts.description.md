# `action.VISION@plugins/plugin-vision/src/action.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-vision
- **File**: `plugins/plugin-vision/src/action.ts:1310`
- **Token count**: 66
- **Last optimized**: never
- **Action**: VISION
- **Similes**: DESCRIBE_SCENE, CAPTURE_IMAGE, SET_VISION_MODE, NAME_ENTITY, IDENTIFY_PERSON, TRACK_ENTITY, ANALYZE_SCENE, WHAT_DO_YOU_SEE, VISION_CHECK, LOOK_AROUND, TAKE_PHOTO, SCREENSHOT, CAPTURE_FRAME, TAKE_PICTURE

## Current text
```
Camera and screen vision: describe the current scene, capture an image, switch vision mode (off/camera/screen/both), name a visible entity, identify a person, or start tracking an entity. The action is inferred from the message text when not explicitly provided.
```

## Compressed variant
```
Vision: describe / capture / set_mode / name_entity / identify_person / track_entity.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (85 chars vs 262 chars — 68% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

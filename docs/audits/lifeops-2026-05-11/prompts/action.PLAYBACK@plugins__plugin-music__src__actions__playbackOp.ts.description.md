# `action.PLAYBACK@plugins/plugin-music/src/actions/playbackOp.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-music
- **File**: `plugins/plugin-music/src/actions/playbackOp.ts:547`
- **Token count**: 42
- **Last optimized**: never
- **Action**: PLAYBACK
- **Similes**: PAUSE_MUSIC, RESUME_MUSIC, STOP_MUSIC, SKIP_TRACK, QUEUE_MUSIC, PAUSE, RESUME, UNPAUSE, SKIP, NEXT_TRACK, ADD_TO_QUEUE

## Current text
```
Music playback control. Use op=pause, resume, skip, stop, or queue. Use this for transport control instead of PLAY_AUDIO. skip, stop, and queue require confirmed:true.
```

## Compressed variant
```
Music playback ops: pause, resume, skip, stop, queue.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

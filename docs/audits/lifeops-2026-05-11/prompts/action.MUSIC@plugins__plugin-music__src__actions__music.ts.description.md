# `action.MUSIC@plugins/plugin-music/src/actions/music.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-music
- **File**: `plugins/plugin-music/src/actions/music.ts:467`
- **Token count**: 111
- **Last optimized**: never
- **Action**: MUSIC
- **Similes**: GENERATE_MUSIC, CREATE_MUSIC, MAKE_MUSIC, COMPOSE_MUSIC, CUSTOM_GENERATE_MUSIC, EXTEND_AUDIO

## Current text
```
Unified music action. Use verb-shaped action for everything: playback (play, pause, resume, skip, stop), queue (queue_view, queue_add, queue_clear), library (playlist_play, playlist_save, search, play_query, download, play_audio), routing/zones (set_routing, set_zone), generation (generate, extend, custom_generate — Suno-backed, requires SUNO_API_KEY). skip, stop, queue_add, queue_clear, playlist_save, and download require confirmed:true.
```

## Compressed variant
```
Verb-shaped: play/pause/resume/skip/stop, queue_view/queue_add/queue_clear, playlist_play/playlist_save, search/play_query/download/play_audio, set_routing/set_zone, generate/extend/custom_generate.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (198 chars vs 442 chars — 55% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

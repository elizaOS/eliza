# `action.MUSIC_LIBRARY@plugins/plugin-music/src/actions/musicLibrary.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-music
- **File**: `plugins/plugin-music/src/actions/musicLibrary.ts:200`
- **Token count**: 94
- **Last optimized**: never
- **Action**: MUSIC_LIBRARY

## Current text
```
Consolidated music library action. Use subaction=playlist with playlistOp=save, load, delete, or add for playlist management; subaction=play_query to research and queue complex music requests; subaction=search_youtube to return YouTube links; subaction=download to fetch music into the local library. Queue changes, downloads, and playlist mutations require confirmed:true.
```

## Compressed variant
```
Music library subactions: playlist(playlistOp save/load/delete/add), play_query, search_youtube, download. Mutations require confirmed:true.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (140 chars vs 373 chars — 62% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

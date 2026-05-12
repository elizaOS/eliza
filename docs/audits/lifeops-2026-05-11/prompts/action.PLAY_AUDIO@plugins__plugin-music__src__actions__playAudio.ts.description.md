# `action.PLAY_AUDIO@plugins/plugin-music/src/actions/playAudio.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-music
- **File**: `plugins/plugin-music/src/actions/playAudio.ts:568`
- **Token count**: 83
- **Last optimized**: never
- **Action**: PLAY_AUDIO
- **Similes**: PLAY_YOUTUBE, PLAY_YOUTUBE_AUDIO, PLAY_VIDEO_AUDIO, PLAY_MUSIC, PLAY_SONG, PLAY_TRACK, START_MUSIC, PLAY_THIS, STREAM_YOUTUBE, PLAY_FROM_YOUTUBE, QUEUE_SONG, ADD_TO_QUEUE

## Current text
```
Start playing a new song: provide a track name, artist, search words, or a media URL. Requires confirmed:true before playback or queue changes. Never use PLAY_AUDIO for pause, resume, stop, skip, or queue — those go through PLAYBACK_OP with op=pause|resume|skip|stop|queue. Do not pass action=pause or similar params to PLAY_AUDIO. 
```

## Compressed variant
```
Play new song by name/artist/URL. Not for pause/resume/stop/skip.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (65 chars vs 332 chars — 80% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

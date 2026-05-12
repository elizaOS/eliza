# `action.ROOM@packages/core/src/features/advanced-capabilities/actions/room.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/advanced-capabilities/actions/room.ts:497`
- **Token count**: 64
- **Last optimized**: never
- **Action**: ROOM
- **Similes**: MUTE_ROOM, UNMUTE_ROOM, FOLLOW_ROOM, UNFOLLOW_ROOM, MUTE_CHAT, UNMUTE_CHAT, MUTE_TELEGRAM, MUTE_DISCORD, SILENCE_GROUP_CHAT, FOLLOW_CHAT, FOLLOW_CHANNEL, FOLLOW_THREAD, UNFOLLOW_CHAT, UNFOLLOW_THREAD, JOIN_ROOM, LEAVE_ROOM, CHAT_THREAD, ROOM

## Current text
```
Mute, unmute, follow, or unfollow a room. Defaults to the current room; targets a specific connector chat when `platform` and `chatName` (or `roomId`) are supplied. `action: mute` with `durationMinutes` returns a scheduling hint for an automatic unmute.
```

## Compressed variant
```
room subscription state: action=mute|unmute|follow|unfollow + optional roomId|platform+chatName + durationMinutes (mute auto-unmute hint)
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (137 chars vs 253 chars — 46% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`

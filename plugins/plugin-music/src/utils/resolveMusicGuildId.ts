import type { Memory } from "@elizaos/core";
import type { MusicService } from "../service";

export type RoomLike = { serverId?: string } | null | undefined;

function findActiveGuildId(musicService: MusicService): string | null {
  const queues = musicService.getQueues();
  for (const [guildId] of queues) {
    if (musicService.getCurrentTrack(guildId)) return guildId;
  }
  return null;
}

/**
 * Resolve the music queue guild id the same way as playAudio / PLAYBACK_OP queue.
 * WHY: Control actions used `room.serverId` alone; on web that is often a raw
 * id while playback uses `web-${roomId}` or `web-${serverId}`, so pause/skip
 * hit a non-existent queue and no-op'd while the agent still replied "Paused".
 */
export function resolveMusicGuildIdForPlayback(
  message: Memory,
  room: RoomLike,
  musicService: MusicService,
): string | null {
  const isDiscord = message.content.source === "discord";

  if (isDiscord) {
    const sid = room?.serverId?.trim();
    if (!sid) {
      return findActiveGuildId(musicService);
    }
    if (musicService.getCurrentTrack(sid)) return sid;
    return findActiveGuildId(musicService);
  }

  const raw = room?.serverId?.trim();
  const guildId = raw ? `web-${raw}` : `web-${message.roomId}`;
  if (musicService.getCurrentTrack(guildId)) return guildId;
  return findActiveGuildId(musicService);
}

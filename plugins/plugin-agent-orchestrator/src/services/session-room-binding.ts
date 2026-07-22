/**
 * Shared room-resolution ladder for ACP session metadata.
 *
 * The orchestrator mints a distinct per-task GROUP room (`taskRoomId`) and
 * stamps it as the session's top-level `metadata.roomId`, while the user's
 * live connector channel is carried on `originRoomId` (and, for some spawn
 * paths, `sourceRoomId`). Any consumer that compares or targets a raw
 * `meta.roomId` therefore diverges from where the user actually is. The
 * router's `readOrigin` (sub-agent-router.ts) resolves the reply room as
 * `originRoomId ?? sourceRoomId ?? taskRoomId ?? roomId`; this module is that
 * same ladder — including readOrigin's UUID validation — extracted so the
 * mid-task forwarder and the progress hook cannot drift from it (each used to
 * re-derive its own subset and silently dropped origin-channel traffic).
 * `session-room-binding.test.ts` pins the agreement with `readOrigin`.
 */

import type { UUID } from "@elizaos/core";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickRoomUuid(value: unknown): UUID | undefined {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value as UUID;
}

/**
 * The user-facing room narration/acks/replies should target, in the same
 * precedence `readOrigin` uses for its reply room. Falls back to the raw
 * `roomId` so sessions spawned without task rooms (or predating them) keep
 * their original target.
 */
export function resolveOriginRoomId(
  meta: Record<string, unknown> | undefined,
): UUID | undefined {
  if (!meta) return undefined;
  return (
    pickRoomUuid(meta.originRoomId) ??
    pickRoomUuid(meta.sourceRoomId) ??
    pickRoomUuid(meta.taskRoomId) ??
    pickRoomUuid(meta.roomId)
  );
}

/**
 * Every room a live session is conversationally bound to: a user message in
 * ANY of these rooms is a follow-up for this session. Covers the minted task
 * room (`roomId`/`taskRoomId`), the origin connector channel
 * (`originRoomId`/`sourceRoomId`), and the per-label thread (`threadRoomId`).
 */
export function sessionBoundRoomIds(
  meta: Record<string, unknown> | undefined,
): Set<UUID> {
  const rooms = new Set<UUID>();
  if (!meta) return rooms;
  for (const key of [
    "roomId",
    "taskRoomId",
    "originRoomId",
    "sourceRoomId",
    "threadRoomId",
  ]) {
    const value = pickRoomUuid(meta[key]);
    if (value) rooms.add(value);
  }
  return rooms;
}

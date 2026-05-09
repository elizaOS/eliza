/**
 * Task heartbeat — one "still working" chat ping per originating room per
 * {@link HEARTBEAT_MIN_INTERVAL_MS}, for any PTY session that's been
 * running past {@link HEARTBEAT_AFTER_MS}.
 *
 * Rate-limited by roomId (not by sessionId) because a swarm can spawn
 * multiple sessions for a single user prompt and the user sees that as
 * one task; firing one heartbeat per session would read as spam.
 *
 * Silent for autonomous sessions (no originating roomId) so background
 * coordinator work doesn't spam chat.
 *
 * @module runtime/task-heartbeat
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readCurrentActivityFromJsonl } from "./subagent-output.ts";

/** Time before the first heartbeat fires for a freshly-spawned session. */
const HEARTBEAT_AFTER_MS = 45_000;
/** Minimum gap between heartbeat messages posted to the same room. */
const HEARTBEAT_MIN_INTERVAL_MS = 120_000;

interface PTYServiceWithEvents {
  onSessionEvent: (
    cb: (sessionId: string, event: string, data: unknown) => void,
  ) => () => void;
  sessionMetadata?: Map<string, Record<string, unknown>>;
  getSession?: (sessionId: string) => { workdir?: string } | undefined;
}

type RuntimeWithMessageTarget = Omit<
  IAgentRuntime,
  "sendMessageToTarget" | "getRoom"
> & {
  sendMessageToTarget: (
    target: { source?: string; roomId?: UUID; channelId?: string },
    message: { text: string; source?: string },
  ) => Promise<unknown>;
  getRoom: (
    roomId: UUID,
  ) => Promise<{ channelId?: string; source?: string } | null>;
};

/**
 * Install the heartbeat on a PTY service. Returns a disposer that
 * unsubscribes the listener. No-op when the service does not expose the
 * event API (tests, mocks).
 */
export function installTaskHeartbeat(
  runtime: IAgentRuntime,
  ptyService: unknown,
): () => void {
  const svc = ptyService as PTYServiceWithEvents | undefined;
  if (!svc || typeof svc.onSessionEvent !== "function") {
    return () => {};
  }

  const sessions = new Map<
    string,
    { startedAt: number; timer: ReturnType<typeof setTimeout> }
  >();
  // Global rate limit: one heartbeat per room per HEARTBEAT_MIN_INTERVAL_MS.
  // A single user prompt can spawn multiple sessions; treating each as its
  // own heartbeat target reads as spam.
  const lastPostedAtByRoom = new Map<string, number>();

  const fire = async (sessionId: string): Promise<void> => {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);

    const meta = svc.sessionMetadata?.get(sessionId);
    const roomId =
      typeof meta?.roomId === "string" ? (meta.roomId as UUID) : null;
    if (!roomId) return;

    const now = Date.now();
    const lastPosted = lastPostedAtByRoom.get(roomId) ?? 0;
    if (now - lastPosted < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastPostedAtByRoom.set(roomId, now);

    const room = await (runtime as RuntimeWithMessageTarget)
      .getRoom(roomId)
      .catch(() => null);
    if (!room?.channelId || !room.source) return;

    const workdir = svc.getSession?.(sessionId)?.workdir;
    const activity = workdir
      ? await readCurrentActivityFromJsonl(workdir).catch(() => null)
      : null;
    const seconds = Math.round((now - state.startedAt) / 1000);
    const text = activity
      ? `still working — ${seconds}s in (${activity})`
      : `still working — ${seconds}s in`;
    await (runtime as RuntimeWithMessageTarget).sendMessageToTarget(
      { source: room.source, roomId, channelId: room.channelId },
      { text, source: "task-heartbeat" },
    );
  };

  return svc.onSessionEvent((sessionId, event) => {
    if (event === "stopped" || event === "task_complete" || event === "error") {
      const state = sessions.get(sessionId);
      if (state) clearTimeout(state.timer);
      sessions.delete(sessionId);
      return;
    }
    if (sessions.has(sessionId)) return;
    sessions.set(sessionId, {
      startedAt: Date.now(),
      timer: setTimeout(() => {
        void fire(sessionId).catch((err) => {
          logger.debug(
            `[task-heartbeat] fire failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, HEARTBEAT_AFTER_MS),
    });
  });
}

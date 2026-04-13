/**
 * Posts task-agent status updates back to the originating chat channel.
 *
 * Subscribes to `ptyService.onSessionEvent` and turns the most useful
 * lifecycle events into a small number of human-readable messages so the
 * user is not left staring at silence while a CREATE_TASK runs in the
 * background. Deliberately quiet — never spams per-tool, never edits, just
 * one heartbeat after a long stretch of work plus a final result.
 *
 * UX contract:
 *   - skip immediately after spawn (the action's own ack already covered it)
 *   - one heartbeat per session, only if the agent is still working after
 *     {@link HEARTBEAT_AFTER_MS}
 *   - one final message on `task_complete` containing the agent's URL line
 *     when present, or a short fallback otherwise
 *   - one error message on `error`
 *
 * Lives in eliza (not in the shared plugin) because routing back to a
 * specific chat target is deployment-specific — other deployments may not
 * have a discord channel id to write to.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readLatestAssistantFromWorkdir } from "./claude-jsonl-completion-watcher.ts";

const HEARTBEAT_AFTER_MS = 45_000;

interface SessionMetadata {
  roomId?: UUID;
  source?: string;
  threadId?: string;
}

interface PTYServiceWithEvents {
  onSessionEvent: (
    cb: (sessionId: string, event: string, data: unknown) => void,
  ) => () => void;
  sessionMetadata?: Map<string, Record<string, unknown>>;
  getSession?: (sessionId: string) => { workdir?: string } | undefined;
}

const installedRuntimes = new WeakSet<IAgentRuntime>();

/**
 * Install the streamer once per runtime. Idempotent — repeat calls are no-ops.
 * Returns silently if the PTY service does not expose the event API (e.g.
 * tests, mocked services).
 */
export function installTaskProgressStreamer(
  runtime: IAgentRuntime,
  ptyService: unknown,
): void {
  if (installedRuntimes.has(runtime)) return;
  const svc = ptyService as PTYServiceWithEvents | undefined;
  if (!svc || typeof svc.onSessionEvent !== "function") return;
  installedRuntimes.add(runtime);

  const sessionStartedAt = new Map<string, number>();
  const sessionWorkdirs = new Map<string, string>();
  const sessionRooms = new Map<
    string,
    {
      roomId: UUID;
      channelId: string;
      source: string;
      serverId?: string;
    }
  >();
  const heartbeatSent = new Set<string>();
  const finalSent = new Set<string>();
  const loginNoticeSent = new Set<string>();

  const forgetSession = (sessionId: string): void => {
    sessionStartedAt.delete(sessionId);
    sessionWorkdirs.delete(sessionId);
    sessionRooms.delete(sessionId);
    heartbeatSent.delete(sessionId);
    loginNoticeSent.delete(sessionId);
    // NOTE: do NOT clear finalSent here. finalSent is a "we already posted the
    // final report for this session" gate and must survive the stopped event,
    // which can fire between task_complete and the 10s postFinalReport delay.
    // Clearing it here would allow a late-arriving duplicate task_complete to
    // schedule a second post. finalSent grows by one per session — bounded by
    // real bot lifetime, acceptable.
  };

  svc.onSessionEvent((sessionId, event, data) => {
    if (!sessionStartedAt.has(sessionId)) {
      sessionStartedAt.set(sessionId, Date.now());
      // Capture workdir + room routing NOW while the session still exists.
      // Both may be cleaned up before the delayed postFinalReport fires.
      const sess = svc.getSession?.(sessionId);
      if (sess?.workdir) sessionWorkdirs.set(sessionId, sess.workdir);
      const meta = svc.sessionMetadata?.get(sessionId) as SessionMetadata | undefined;
      if (meta?.roomId) {
        void (async () => {
          const room = await runtime.getRoom(meta.roomId!).catch(() => null);
          if (room?.source) {
            sessionRooms.set(sessionId, {
              roomId: meta.roomId!,
              channelId: room.channelId ?? room.id,
              source: room.source,
              serverId: room.serverId,
            });
          }
        })();
      }
    }

    if (
      event === "tool_running" &&
      !heartbeatSent.has(sessionId) &&
      !finalSent.has(sessionId)
    ) {
      // Gate on BOTH flags. heartbeatSent prevents multiple heartbeats
      // per session. finalSent prevents a heartbeat from firing after
      // the final report has already been posted — without this, late
      // tool_running events from a lingering subagent (one that didn't
      // die after task_complete) would post a stale "still working —
      // Ns in" message minutes after the user already got their answer.
      const elapsed = Date.now() - (sessionStartedAt.get(sessionId) ?? 0);
      if (elapsed < HEARTBEAT_AFTER_MS) return;
      heartbeatSent.add(sessionId);
      void postToOriginatingChannel(
        runtime,
        svc,
        sessionId,
        `still working — ${Math.round(elapsed / 1000)}s in, will report when done`,
        sessionRooms,
      );
      return;
    }

    if (event === "task_complete" && !finalSent.has(sessionId)) {
      // Mark as final IMMEDIATELY at schedule time (not inside the setTimeout
      // callback) so any additional task_complete events fired before the 10s
      // timer resolves cannot schedule a second post. task_complete fires
      // once per prompt-reappearance; if the subagent prints multiple
      // prompts in quick succession we only want one discord message.
      finalSent.add(sessionId);
      logger.info(
        `[task-progress-streamer] scheduling final report for ${sessionId}`,
      );
      // task_complete fires after EVERY tool call (when the agent's prompt
      // reappears), not only after the final response. wait a bit for the
      // agent to flush its answer to the session jsonl before reading.
      // Capture both workdir and room info NOW — the stopped event may fire
      // before the 10s delay and clear the maps via forgetSession.
      const cachedWorkdir = sessionWorkdirs.get(sessionId);
      setTimeout(async () => {
        // Resolve room routing HERE (not at session start) because the
        // fire-and-forget async lookup at start may not have finished yet.
        let roomCache: typeof sessionRooms;
        const cachedRoom = sessionRooms.get(sessionId);
        if (cachedRoom) {
          // Snapshot the entry — forgetSession may delete it from sessionRooms
          // before this callback runs.
          roomCache = new Map([[sessionId, cachedRoom]]);
        } else {
          const meta = svc.sessionMetadata?.get(sessionId) as SessionMetadata | undefined;
          let roomId = meta?.roomId;
          if (!roomId && meta?.threadId) {
            const coordinator = runtime.getService("SWARM_COORDINATOR") as
              | { getTaskThread?: (threadId: string) => Promise<{ roomId?: UUID | null } | null> }
              | undefined;
            const thread = await coordinator?.getTaskThread?.(meta.threadId).catch(
              () => null,
            );
            if (thread?.roomId) {
              roomId = thread.roomId;
            }
          }
          if (roomId) {
            const room = await runtime.getRoom(roomId).catch(() => null);
            if (room?.source) {
              roomCache = new Map([[sessionId, {
                roomId,
                channelId: room.channelId ?? room.id,
                source: room.source,
                serverId: room.serverId,
              }]]);
            } else {
              roomCache = new Map();
            }
          } else {
            roomCache = new Map();
          }
        }
        logger.info(
          `[task-progress-streamer] dispatching final report for ${sessionId}`,
        );
        void postFinalReport(runtime, svc, sessionId, cachedWorkdir, roomCache);
      }, 10_000);
      return;
    }

    if (event === "login_required" && !loginNoticeSent.has(sessionId)) {
      loginNoticeSent.add(sessionId);
      const login = data as { instructions?: string; url?: string } | undefined;
      const message = [
        "task agent needs a provider login before it can continue",
        login?.instructions?.trim() ?? "",
        login?.url ? `Login link: ${login.url}` : "",
      ]
        .filter(Boolean)
        .join(". ");
      void postToOriginatingChannel(
        runtime,
        svc,
        sessionId,
        message,
        sessionRooms,
      );
      return;
    }

    if (event === "error" && !finalSent.has(sessionId)) {
      finalSent.add(sessionId);
      void postToOriginatingChannel(
        runtime,
        svc,
        sessionId,
        (() => {
          const message =
            (data as { message?: string } | undefined)?.message?.trim() ?? "";
          return message
            ? `task agent errored: ${message}`
            : "task agent errored — check logs";
        })(),
        sessionRooms,
      );
      return;
    }

    if (event === "stopped" && !finalSent.has(sessionId)) {
      finalSent.add(sessionId);
      void postToOriginatingChannel(
        runtime,
        svc,
        sessionId,
        "task agent stopped before completion",
        sessionRooms,
      );
      return;
    }

    if (event === "stopped") {
      forgetSession(sessionId);
    }
  });
}

async function postFinalReport(
  runtime: IAgentRuntime,
  svc: PTYServiceWithEvents,
  sessionId: string,
  workdir?: string,
  roomCache?: Map<
    string,
    { roomId: UUID; channelId: string; source: string; serverId?: string }
  >,
): Promise<void> {
  const entry = workdir
    ? await readLatestAssistantFromWorkdir(workdir)
    : null;
  const assistantText = entry?.text ?? null;
  if (assistantText) {
    const urlLine = assistantText
      .split("\n")
      .find((line) => /^\s*URL:\s*https?:\/\//i.test(line));
    // If the subagent reported a URL, collapse the whole response to just
    // "done — URL: ..." — that's the agent-home pattern contract.
    // Otherwise send the full assistant text, chunked to fit discord's 2000
    // char message limit.
    const chunks = urlLine
      ? [`done — ${urlLine.trim()}`]
      : chunkForDiscord(assistantText, 1900);
    for (const chunk of chunks) {
      await postToOriginatingChannel(runtime, svc, sessionId, chunk, roomCache);
    }
    return;
  }
  await postToOriginatingChannel(runtime, svc, sessionId, "task finished", roomCache);
}

/**
 * Split `text` into chunks no larger than `max` characters, preferring to
 * break at paragraph boundaries (\n\n), then line boundaries (\n), then
 * word boundaries (space). Discord's hard limit per message is 2000 chars —
 * callers should pass 1900 or lower to leave headroom for formatting.
 *
 * Exported for tests.
 */
export function chunkForDiscord(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Only accept a split point if it's past the halfway mark — otherwise
    // we'd create tiny sliver chunks. Fall back to harder cut points (or a
    // brute-force slice) when no good boundary is available.
    const half = Math.floor(max / 2);
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < half) cut = remaining.lastIndexOf("\n", max);
    if (cut < half) cut = remaining.lastIndexOf(" ", max);
    if (cut < half) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}

async function postToOriginatingChannel(
  runtime: IAgentRuntime,
  svc: PTYServiceWithEvents,
  sessionId: string,
  text: string,
  roomCache?: Map<
    string,
    { roomId: UUID; channelId: string; source: string; serverId?: string }
  >,
): Promise<void> {
  let roomId: UUID | undefined;
  let channelId: string | undefined;
  let source: string | undefined;
  let serverId: string | undefined;
  const cached = roomCache?.get(sessionId);
  if (cached) {
    roomId = cached.roomId;
    channelId = cached.channelId;
    source = cached.source;
    serverId = cached.serverId;
  } else {
    const meta = svc.sessionMetadata?.get(sessionId) as SessionMetadata | undefined;
    if (meta?.roomId) {
      roomId = meta.roomId;
    } else if (meta?.threadId) {
      const coordinator = runtime.getService("SWARM_COORDINATOR") as
        | { getTaskThread?: (threadId: string) => Promise<{ roomId?: UUID | null } | null> }
        | undefined;
      const thread = await coordinator?.getTaskThread?.(meta.threadId).catch(
        () => null,
      );
      if (thread?.roomId) {
        roomId = thread.roomId;
      }
    }
    if (!roomId) return;
    const room = await runtime.getRoom(roomId).catch(() => null);
    source = room?.source ?? meta?.source;
    channelId = room?.channelId ?? room?.id ?? roomId;
    serverId = room?.serverId;
  }
  if (!roomId || !channelId || !source) return;
  try {
    await runtime.sendMessageToTarget(
      ({
        source,
        roomId,
        channelId,
        serverId,
      } as Parameters<typeof runtime.sendMessageToTarget>[0]),
      { text, source },
    );
  } catch (err) {
    logger.warn(
      `[task-progress-streamer] failed to send update for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

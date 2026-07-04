/**
 * Surfaces the real git change set from the most recent completed coding
 * sub-agent so the parent can answer "what did you change / show me the
 * diff / what did you add" from ground truth instead of confabulating a
 * plausible-sounding edit (the dogsite "I added a 🤣 emoji" failure, where
 * the sub-agent's actual task was an image swap).
 *
 * The change set is captured from git at task_complete (sub-agent-router →
 * workspace-diff) and persisted on session.metadata.lastChangeSet. This
 * provider reads the freshest one within a recency window so a stale build
 * from days ago doesn't bleed into an unrelated conversation.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  getAcpService,
  reportProviderFetchFailure,
} from "../actions/common.js";
import type { SessionInfo } from "../services/types.js";
import type { WorkspaceChangeSet } from "../services/workspace-diff.js";

const RECENCY_WINDOW_MS = 30 * 60_000;
const MAX_FILES_LISTED = 20;
const MAX_DIFF_LINES = 50;

function readChangeSet(session: SessionInfo): WorkspaceChangeSet | undefined {
  const raw = (session.metadata as Record<string, unknown> | undefined)
    ?.lastChangeSet;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<WorkspaceChangeSet>;
  if (!Array.isArray(candidate.changedFiles)) return undefined;
  if (typeof candidate.capturedAt !== "number") return undefined;
  return candidate as WorkspaceChangeSet;
}

function sessionLabel(session: SessionInfo): string {
  const label = (session.metadata as Record<string, unknown> | undefined)
    ?.label;
  return typeof label === "string" ? label : (session.name ?? session.id);
}

export const codingSessionChangesProvider: Provider = {
  name: "CODING_SESSION_CHANGES",
  description:
    "The real git change set (files + diff) from the most recent completed coding sub-agent, for answering 'what did you change / show me the diff'",
  descriptionCompressed:
    "Recent coding sub-agent's actual file changes + diff.",
  position: 1,
  // Like FACTS, this must reach the simple path: "show me the diff" is
  // classified as a simple direct reply with no tools, so the change set has
  // to be in Stage-1 state regardless of context. The flag opts this provider
  // into the always-on response state set without core naming the plugin.
  // Self-limiting: emits empty text unless a recent change set exists.
  alwaysInResponseState: true,
  cacheStable: false,
  cacheScope: "turn",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const acp = getAcpService(runtime);
    if (!acp) return { text: "", values: {}, data: {} };

    let sessions: SessionInfo[] = [];
    try {
      sessions = await Promise.race([
        Promise.resolve(acp.listSessions()),
        // error-policy:J4 the 2s cap prevents a hung ACP backend from stalling
        // every Stage-1 turn; resolving [] here is a bounded degrade, not a
        // fabricated "no sessions" — the diff-grounding block is purely additive
        // (it only ever ADDS a real recent change set), so an empty read drops
        // the block rather than asserting anything false to the model.
        new Promise<SessionInfo[]>((resolve) =>
          setTimeout(() => resolve([]), 2000),
        ),
      ]);
    } catch (err) {
      // error-policy:J7 listSessions threw — the ACP backend is broken, not
      // "no coding changes." Surface it (warn + reportError) instead of the
      // old invisible debug so a down backend is developer/owner-visible, then
      // drop the additive diff block for this turn (crash-free provider
      // contract). The block is purely additive, so omitting it never asserts
      // a false "nothing changed" — it just declines to ground.
      reportProviderFetchFailure(
        runtime,
        "CODING_SESSION_CHANGES",
        "listSessions",
        err,
      );
      return { text: "", values: {}, data: {} };
    }

    const scopedSessions = sessions.filter((session) =>
      sessionMatchesMessage(session, message),
    );

    // Surface the most recent ACTUAL change set within the recency window.
    // Only real change sets are persisted (an unchanged completion stores nothing),
    // so this correctly picks the changing round of a multi-round task and
    // can't resurrect a stale diff older than the window. The session is kept
    // alongside its change set for the task label.
    const now = Date.now();
    const top = scopedSessions
      .map((s) => ({ session: s, changeSet: readChangeSet(s) }))
      .filter(
        (e): e is { session: SessionInfo; changeSet: WorkspaceChangeSet } =>
          e.changeSet !== undefined &&
          e.changeSet.changedFiles.length > 0 &&
          now - e.changeSet.capturedAt <= RECENCY_WINDOW_MS,
      )
      .sort((a, b) => b.changeSet.capturedAt - a.changeSet.capturedAt)[0];
    if (!top) return { text: "", values: {}, data: {} };

    // Staleness guard. The change set above is the most recent one PERSISTED,
    // but a subsequent coding task may have run since and produced no captured diff
    // (e.g. it wrote only to a gitignored deploy dir, or made no tracked
    // change). Reaching back to the older persisted set is how an unrelated
    // diff leaks into a follow-up ("what did you change?" after task B
    // surfacing task A's diff). If any OTHER session was spawned after this set
    // was captured — i.e. a newer task is the one the user is really asking
    // about — don't surface the stale set; ground the model to answer honestly.
    const capturedAt = top.changeSet.capturedAt;
    const newerTaskSince = scopedSessions.some((s) => {
      const created = dateMs(s.createdAt);
      return s.id !== top.session.id && created > capturedAt;
    });
    if (newerTaskSince) {
      const note =
        "recent_coding_changes:\n  note: Your most recent coding task did not produce a captured file diff (it may have written only to a deploy directory, or made no tracked change). If the user asks what you changed or to see the diff, say honestly that you completed the latest task but don't have a captured diff to show for it — do NOT describe an older or unrelated change, and never invent edits.";
      return { text: note, values: { recentCodingChanges: note }, data: {} };
    }
    const { session, changeSet } = top;
    const files = changeSet.changedFiles.slice(0, MAX_FILES_LISTED);
    const fileLine =
      changeSet.changedFiles.length > MAX_FILES_LISTED
        ? `${files.join(", ")} (+${changeSet.changedFiles.length - MAX_FILES_LISTED} more)`
        : files.join(", ");

    const lines = [
      "recent_coding_changes:",
      `  task: ${sessionLabel(session)}`,
      `  changedFiles: ${fileLine}`,
    ];
    if (changeSet.diffStat) lines.push(`  stat: ${changeSet.diffStat}`);
    if (changeSet.diff) {
      // Cap the rendered diff: this block is injected into every Stage-1 turn
      // for the recency window, so keep it lean (the full diff lives on
      // session metadata). Small site/app edits fit well under this.
      const diffLines = changeSet.diff.split("\n");
      const shown = diffLines.slice(0, MAX_DIFF_LINES);
      lines.push("  diff: |");
      for (const diffLine of shown) lines.push(`    ${diffLine}`);
      if (diffLines.length > MAX_DIFF_LINES || changeSet.truncated) {
        lines.push(
          `    … [diff truncated — ${changeSet.changedFiles.length} file(s) total]`,
        );
      }
    }
    lines.push(
      "  note: The files and diff above ARE the real change set from your own coding work in this conversation — you have them right here. When the user asks what you changed or to see the diff, answer directly from this with a short, chat-friendly summary: name the file(s) and describe what changed, quoting the key changed line(s) when helpful. Keep it concise (a few lines). Do NOT say you lack the files, the source, the repository, or access — the change set is provided above. Never invent edits beyond it.",
    );

    const text = lines.join("\n");
    return {
      data: {
        recentCodingChanges: {
          task: sessionLabel(session),
          changedFiles: changeSet.changedFiles,
          diffStat: changeSet.diffStat,
          truncated: changeSet.truncated,
        },
      },
      values: { recentCodingChanges: text },
      text,
    };
  },
};

function dateMs(value: Date | string | number | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sessionMatchesMessage(session: SessionInfo, message: Memory): boolean {
  const roomId = typeof message.roomId === "string" ? message.roomId : "";
  if (!roomId) return false;
  const metadata = session.metadata as Record<string, unknown> | undefined;
  if (!metadata) return false;
  if (
    [
      metadata.roomId,
      metadata.taskRoomId,
      metadata.worktreeRoomId,
      metadata.originRoomId,
    ]
      .filter((value): value is string => typeof value === "string")
      .includes(roomId)
  ) {
    return true;
  }
  const swarmRooms = Array.isArray(metadata.swarmRooms)
    ? metadata.swarmRooms
    : [];
  return swarmRooms.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { roomId?: unknown }).roomId === roomId;
  });
}

/**
 * Selects browser work for a companion, preferring an unfinished session it
 * already claimed so extension worker restarts resume from the durable action
 * checkpoint instead of stranding the session in `running`.
 */
import type { BrowserBridgeCompanionStatus } from "@elizaos/plugin-browser";
import type { LifeOpsBrowserSession } from "../../contracts/index.js";

function matchesCompanion(
  session: LifeOpsBrowserSession,
  companion: BrowserBridgeCompanionStatus,
): boolean {
  return (
    (!session.browser || session.browser === companion.browser) &&
    (!session.companionId || session.companionId === companion.id) &&
    (!session.profileId || session.profileId === companion.profileId)
  );
}

function claimedByCompanion(
  session: LifeOpsBrowserSession,
  companion: BrowserBridgeCompanionStatus,
): boolean {
  return session.metadata.claimedByCompanionId === companion.id;
}

function oldestFirst(
  left: LifeOpsBrowserSession,
  right: LifeOpsBrowserSession,
): number {
  const leftMs = Date.parse(left.createdAt);
  const rightMs = Date.parse(right.createdAt);
  if (
    Number.isFinite(leftMs) &&
    Number.isFinite(rightMs) &&
    leftMs !== rightMs
  ) {
    return leftMs - rightMs;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function selectBrowserSessionForCompanion(
  sessions: readonly LifeOpsBrowserSession[],
  companion: BrowserBridgeCompanionStatus,
): LifeOpsBrowserSession | null {
  const matching = sessions.filter((session) =>
    matchesCompanion(session, companion),
  );
  return (
    matching
      .filter(
        (session) =>
          session.status === "running" &&
          claimedByCompanion(session, companion),
      )
      .sort(oldestFirst)[0] ??
    matching
      .filter((session) => session.status === "queued")
      .sort(oldestFirst)[0] ??
    null
  );
}

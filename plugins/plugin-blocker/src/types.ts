/**
 * Public types + constants for @elizaos/plugin-blocker.
 *
 * MIGRATION NOTE: these types replace the local types previously embedded in
 *   plugins/plugin-lifeops/src/website-blocker/types.ts (not yet extracted)
 *   plugins/plugin-lifeops/src/app-blocker/types.ts
 * Once the real migration phase lands, those source files will move into this
 * package under src/services/ and src/actions/.
 */

export const BLOCKER_LOG_PREFIX = "[Blocker]";
export const WEBSITE_BLOCKER_SERVICE_TYPE = "website-blocker";
export const APP_BLOCKER_SERVICE_TYPE = "app-blocker";

export const BLOCK_TARGETS = ["app", "website"] as const;
export type BlockTarget = (typeof BLOCK_TARGETS)[number];

export const BLOCK_SUBACTIONS = [
  "block",
  "unblock",
  "status",
  "request_permission",
  "release",
  "list_active",
] as const;
export type BlockSubaction = (typeof BLOCK_SUBACTIONS)[number];

export const BLOCKER_CONTEXTS = ["focus", "automation"] as const;
export type BlockerContext = (typeof BLOCKER_CONTEXTS)[number];

/** A scheduled focus / block session row. */
export interface BlockSession {
  id: string;
  agentId: string;
  entityId: string;
  target: BlockTarget;
  startedAt: Date;
  endsAt: Date | null;
  rules: string[];
  status: "active" | "ended" | "released";
}

/** A rule entry (hostname or bundle id) the blocker enforces. */
export interface BlockRule {
  id: string;
  agentId: string;
  entityId: string;
  target: BlockTarget;
  pattern: string;
  notes: string | null;
  createdAt: Date;
}

/** Allow-list entry — exempted from a future block. */
export interface AllowListEntry {
  id: string;
  agentId: string;
  entityId: string;
  target: BlockTarget;
  pattern: string;
  reason: string | null;
  createdAt: Date;
}

/**
 * Public types + constants for @elizaos/plugin-blocker.
 */

export const BLOCKER_LOG_PREFIX = "[Blocker]";
// Runtime serviceType strings — must match the values registered at runtime.
// WebsiteBlockerService extends SelfControlBlockerService and registers as
// `website_blocker`; the SelfControl base registers as `selfcontrol_blocker`.
export const WEBSITE_BLOCKER_SERVICE_TYPE = "website_blocker";
export const SELFCONTROL_BLOCKER_SERVICE_TYPE = "selfcontrol_blocker";
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

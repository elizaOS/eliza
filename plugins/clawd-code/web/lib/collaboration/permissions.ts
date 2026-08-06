import type { CollabRole } from "./socket";
import type { LinkExpiry, ShareLink } from "./types";
import { nanoid } from "nanoid";

// ─── Role Hierarchy ───────────────────────────────────────────────────────────

const ROLE_RANK: Record<CollabRole, number> = {
  owner: 3,
  collaborator: 2,
  viewer: 1,
};

export function hasPermission(role: CollabRole, required: CollabRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function canSendMessages(role: CollabRole): boolean {
  return hasPermission(role, "collaborator");
}

export function canApproveTools(
  role: CollabRole,
  policy: "owner-only" | "any-collaborator",
  isOwner: boolean
): boolean {
  if (policy === "owner-only") return isOwner;
  return hasPermission(role, "collaborator");
}

export function canManageAccess(role: CollabRole): boolean {
  return role === "owner";
}

export function canTransferOwnership(role: CollabRole): boolean {
  return role === "owner";
}

export function canAddAnnotations(role: CollabRole): boolean {
  return hasPermission(role, "collaborator");
}

export function canChangeRole(
  actorRole: CollabRole,
  targetRole: CollabRole
): boolean {
  // Owner can change any role; collaborators cannot manage access at all
  return actorRole === "owner" && targetRole !== "owner";
}

// ─── Share Links ──────────────────────────────────────────────────────────────

const EXPIRY_MS: Record<LinkExpiry, number | null> = {
  "1h": 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  never: null,
};

export function createShareLink(
  sessionId: string,
  role: CollabRole,
  expiry: LinkExpiry,
  createdBy: string
): ShareLink {
  const expiryMs = EXPIRY_MS[expiry];
  return {
    id: nanoid(12),
    sessionId,
    role,
    createdAt: Date.now(),
    expiresAt: expiryMs !== null ? Date.now() + expiryMs : null,
    createdBy,
  };
}

export function isLinkExpired(link: ShareLink): boolean {
  return link.expiresAt !== null && Date.now() > link.expiresAt;
}

export function buildShareUrl(linkId: string, role: CollabRole): string {
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000";
  return `${base}/join/${linkId}?role=${role}`;
}

export function labelForRole(role: CollabRole): string {
  return { owner: "Owner", collaborator: "Collaborator", viewer: "Viewer" }[
    role
  ];
}

export function descriptionForRole(role: CollabRole): string {
  return {
    owner: "Full control — can send messages, approve tools, and manage access",
    collaborator: "Can send messages and approve tool use",
    viewer: "Read-only — can watch the session in real-time",
  }[role];
}

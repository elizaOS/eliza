import type { CollabUser, AnnotationReply } from "./socket";

// ─── Annotation ───────────────────────────────────────────────────────────────

export interface CollabAnnotation {
  id: string;
  messageId: string;
  parentId?: string; // for threaded top-level grouping (unused in v1)
  text: string;
  author: CollabUser;
  createdAt: number;
  resolved: boolean;
  replies: AnnotationReply[];
}

// ─── Pending Tool Use ─────────────────────────────────────────────────────────

export interface PendingToolUse {
  id: string; // toolUseId
  name: string;
  input: Record<string, unknown>;
  messageId: string;
  requestedAt: number;
}

// ─── Share Link ───────────────────────────────────────────────────────────────

export type LinkExpiry = "1h" | "24h" | "7d" | "never";

export interface ShareLink {
  id: string;
  sessionId: string;
  role: import("./socket").CollabRole;
  createdAt: number;
  expiresAt: number | null; // null = never expires
  createdBy: string;
}

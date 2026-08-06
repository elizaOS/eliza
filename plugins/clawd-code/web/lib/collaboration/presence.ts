import type { CollabUser } from "./socket";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CursorState {
  userId: string;
  position: number;
  selectionStart?: number;
  selectionEnd?: number;
  updatedAt: number;
}

export interface PresenceState {
  users: Map<string, CollabUser>;
  cursors: Map<string, CursorState>;
  typing: Set<string>; // user IDs currently typing
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPresenceState(): PresenceState {
  return {
    users: new Map(),
    cursors: new Map(),
    typing: new Set(),
  };
}

// ─── Updaters (all return new state, immutable) ───────────────────────────────

export function presenceAddUser(
  state: PresenceState,
  user: CollabUser
): PresenceState {
  return { ...state, users: new Map(state.users).set(user.id, user) };
}

export function presenceRemoveUser(
  state: PresenceState,
  userId: string
): PresenceState {
  const users = new Map(state.users);
  users.delete(userId);
  const cursors = new Map(state.cursors);
  cursors.delete(userId);
  const typing = new Set(state.typing);
  typing.delete(userId);
  return { users, cursors, typing };
}

export function presenceSyncUsers(
  state: PresenceState,
  users: CollabUser[]
): PresenceState {
  const map = new Map<string, CollabUser>();
  users.forEach((u) => map.set(u.id, u));
  return { ...state, users: map };
}

export function presenceUpdateCursor(
  state: PresenceState,
  userId: string,
  position: number,
  selectionStart?: number,
  selectionEnd?: number
): PresenceState {
  const cursor: CursorState = {
    userId,
    position,
    selectionStart,
    selectionEnd,
    updatedAt: Date.now(),
  };
  return { ...state, cursors: new Map(state.cursors).set(userId, cursor) };
}

export function presenceSetTyping(
  state: PresenceState,
  userId: string,
  isTyping: boolean
): PresenceState {
  const typing = new Set(state.typing);
  if (isTyping) {
    typing.add(userId);
  } else {
    typing.delete(userId);
  }
  return { ...state, typing };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

export function getUserColor(index: number): string {
  return USER_COLORS[index % USER_COLORS.length];
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

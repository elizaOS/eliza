import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringToUuid, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type {
  ChatRoom,
  JsonValue,
  Message,
  MessageRole,
  PaneFocus,
  SubAgentType,
  TaskPaneVisibility,
} from "../types.js";
import {
  ensureSessionIdentity,
  isUuidString,
  type SessionIdentity,
} from "./identity.js";

const SESSION_DIR = ".eliza-code";
const SESSION_FILE = "session.json";

export interface SessionData {
  version: 1;
  savedAt: number;
  currentRoomId: string;
  currentTaskId: string | null;
  rooms: SerializedRoom[];
  cwd: string;
  selectedSubAgentType?: SubAgentType | null;
  // Identity fields are optional for backwards compatibility with older sessions.
  projectId?: UUID;
  userId?: UUID;
  worldId?: UUID;
  messageServerId?: UUID;
  // UI state (optional for backwards compatibility)
  focusedPane?: PaneFocus;
  taskPaneVisibility?: TaskPaneVisibility;
  taskPaneWidthFraction?: number;
  showFinishedTasks?: boolean;
}

export interface SerializedRoom {
  id: string;
  name: string;
  messages: SerializedMessage[];
  createdAt: number;
  taskIds: string[];
  elizaRoomId: string;
}

export interface SerializedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  roomId: string;
  taskId?: string;
}

function getSessionPath(): string {
  return path.join(process.cwd(), SESSION_DIR, SESSION_FILE);
}

async function ensureSessionDir(): Promise<void> {
  const dir = path.join(process.cwd(), SESSION_DIR);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Ignore if exists
  }
}

/**
 * Safely convert a timestamp value to epoch milliseconds.
 * Handles Date objects, numbers, and ISO strings.
 */
function toEpoch(value: Date | number | string | undefined): number {
  if (!value) return Date.now();
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

/**
 * Safely convert an epoch timestamp to a Date object.
 */
function toDate(epoch: number | undefined): Date {
  if (!epoch || typeof epoch !== "number" || Number.isNaN(epoch)) {
    return new Date();
  }
  return new Date(epoch);
}

/**
 * Validate and sanitize a message role.
 */
function sanitizeRole(role: string): MessageRole {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return "system";
}

function shouldPersistToDisk(): boolean {
  if (process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE === "1") return false;
  if (process.env.BUN_TEST === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function serializeRoom(room: ChatRoom): SerializedRoom {
  return {
    id: room.id || uuidv4(),
    name: room.name || "Chat",
    messages: (room.messages || []).map((msg) => ({
      id: msg.id || uuidv4(),
      role: sanitizeRole(msg.role),
      content: msg.content || "",
      timestamp: toEpoch(msg.timestamp),
      roomId: msg.roomId || room.id,
      taskId: msg.taskId,
    })),
    createdAt: toEpoch(room.createdAt),
    taskIds: room.taskIds || [],
    elizaRoomId: room.elizaRoomId,
  };
}

function deserializeRoom(data: SerializedRoom): ChatRoom {
  // Validate required fields
  const id = data.id || uuidv4();
  const name = data.name || "Chat";
  const elizaRoomIdRaw =
    typeof data.elizaRoomId === "string" ? data.elizaRoomId : "";
  const elizaRoomId: UUID = isUuidString(elizaRoomIdRaw)
    ? elizaRoomIdRaw
    : stringToUuid(`eliza-code:room:${id}`);

  return {
    id,
    name,
    messages: (data.messages || []).map(
      (msg): Message => ({
        id: msg.id || uuidv4(),
        role: sanitizeRole(msg.role),
        content: msg.content || "",
        timestamp: toDate(msg.timestamp),
        roomId: msg.roomId || id,
        taskId: msg.taskId,
      }),
    ),
    createdAt: toDate(data.createdAt),
    taskIds: data.taskIds || [],
    elizaRoomId,
  };
}

/**
 * Validate session data structure.
 */
function isValidSessionData(data: unknown): data is SessionData {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === 1 &&
    typeof d.currentRoomId === "string" &&
    Array.isArray(d.rooms)
  );
}

export interface SessionState {
  rooms: ChatRoom[];
  currentRoomId: string;
  currentTaskId: string | null;
  cwd: string;
  identity: SessionIdentity;
  selectedSubAgentType?: SubAgentType | null;
  // UI state (optional)
  focusedPane?: PaneFocus;
  taskPaneVisibility?: TaskPaneVisibility;
  taskPaneWidthFraction?: number;
  showFinishedTasks?: boolean;
}

/**
 * Save session state to disk
 */
export async function saveSession(state: SessionState): Promise<void> {
  await ensureSessionDir();

  const data: SessionData = {
    version: 1,
    savedAt: Date.now(),
    currentRoomId: state.currentRoomId,
    currentTaskId: state.currentTaskId,
    rooms: state.rooms.map(serializeRoom),
    cwd: state.cwd,
    selectedSubAgentType: state.selectedSubAgentType ?? null,
    projectId: state.identity.projectId,
    userId: state.identity.userId,
    worldId: state.identity.worldId,
    messageServerId: state.identity.messageServerId,
    focusedPane: state.focusedPane,
    taskPaneVisibility: state.taskPaneVisibility,
    taskPaneWidthFraction: state.taskPaneWidthFraction,
    showFinishedTasks: state.showFinishedTasks,
  };

  const sessionPath = getSessionPath();
  await fs.writeFile(sessionPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Load session state from disk
 */
export async function loadSession(): Promise<SessionState | null> {
  try {
    const sessionPath = getSessionPath();
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content) as JsonValue;

    // Validate session structure
    if (!isValidSessionData(data)) {
      return null;
    }

    // Deserialize rooms with validation
    let needsMigrationSave = false;
    const rooms = data.rooms
      .map((roomData) => {
        try {
          if (!isUuidString(roomData.elizaRoomId)) {
            needsMigrationSave = true;
          }
          return deserializeRoom(roomData);
        } catch {
          return null;
        }
      })
      .filter((room): room is ChatRoom => room !== null);

    // Must have at least one valid room
    if (rooms.length === 0) {
      return null;
    }

    // Ensure currentRoomId exists in the rooms
    const currentRoomId = rooms.some((r) => r.id === data.currentRoomId)
      ? data.currentRoomId
      : rooms[0].id;

    const record = data as Record<string, JsonValue>;
    const identity = ensureSessionIdentity({
      projectId:
        typeof record.projectId === "string" && isUuidString(record.projectId)
          ? (record.projectId as UUID)
          : undefined,
      userId:
        typeof record.userId === "string" && isUuidString(record.userId)
          ? (record.userId as UUID)
          : undefined,
      worldId:
        typeof record.worldId === "string" && isUuidString(record.worldId)
          ? (record.worldId as UUID)
          : undefined,
      messageServerId:
        typeof record.messageServerId === "string" &&
        isUuidString(record.messageServerId)
          ? (record.messageServerId as UUID)
          : undefined,
    });

    const state: SessionState = {
      rooms,
      currentRoomId,
      currentTaskId: data.currentTaskId ?? null,
      cwd: data.cwd || process.cwd(),
      identity,
      selectedSubAgentType:
        typeof record.selectedSubAgentType === "string"
          ? (record.selectedSubAgentType as SubAgentType)
          : null,
      focusedPane:
        typeof record.focusedPane === "string"
          ? (record.focusedPane as PaneFocus)
          : undefined,
      taskPaneVisibility:
        typeof record.taskPaneVisibility === "string"
          ? (record.taskPaneVisibility as TaskPaneVisibility)
          : undefined,
      taskPaneWidthFraction:
        typeof record.taskPaneWidthFraction === "number"
          ? record.taskPaneWidthFraction
          : undefined,
      showFinishedTasks:
        typeof record.showFinishedTasks === "boolean"
          ? record.showFinishedTasks
          : undefined,
    };

    // If we repaired invalid UUIDs (e.g. bad elizaRoomId from earlier runs/tests), persist the fixed session.
    if (needsMigrationSave && shouldPersistToDisk()) {
      try {
        await saveSession(state);
      } catch {
        // ignore
      }
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Clear session file
 */
export async function clearSession(): Promise<void> {
  try {
    const sessionPath = getSessionPath();
    await fs.unlink(sessionPath);
  } catch {
    // Ignore if doesn't exist
  }
}

// ============================================================================
// Exports for Testing
// ============================================================================

export {
  toEpoch,
  toDate,
  sanitizeRole,
  serializeRoom,
  deserializeRoom,
  isValidSessionData,
  getSessionPath,
};

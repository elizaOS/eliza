"use client";

// ─── Role & User ────────────────────────────────────────────────────────────

export type CollabRole = "owner" | "collaborator" | "viewer";

export interface CollabUser {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  color: string; // hex color assigned per session
  role: CollabRole;
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export type CollabEventType =
  | "message_added"
  | "message_streaming"
  | "tool_use_pending"
  | "tool_use_approved"
  | "tool_use_denied"
  | "user_joined"
  | "user_left"
  | "cursor_update"
  | "typing_start"
  | "typing_stop"
  | "presence_sync"
  | "annotation_added"
  | "annotation_resolved"
  | "annotation_reply"
  | "role_changed"
  | "access_revoked"
  | "ownership_transferred"
  | "session_state"
  | "error";

interface BaseCollabEvent {
  type: CollabEventType;
  sessionId: string;
  userId: string;
  timestamp: number;
}

export interface MessageAddedEvent extends BaseCollabEvent {
  type: "message_added";
  message: {
    id: string;
    role: string;
    content: unknown;
    status: string;
    createdAt: number;
  };
}

export interface MessageStreamingEvent extends BaseCollabEvent {
  type: "message_streaming";
  messageId: string;
  delta: string;
  done: boolean;
}

export interface ToolUsePendingEvent extends BaseCollabEvent {
  type: "tool_use_pending";
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  messageId: string;
}

export interface ToolUseApprovedEvent extends BaseCollabEvent {
  type: "tool_use_approved";
  toolUseId: string;
  approvedBy: CollabUser;
}

export interface ToolUseDeniedEvent extends BaseCollabEvent {
  type: "tool_use_denied";
  toolUseId: string;
  deniedBy: CollabUser;
}

export interface UserJoinedEvent extends BaseCollabEvent {
  type: "user_joined";
  user: CollabUser;
}

export interface UserLeftEvent extends BaseCollabEvent {
  type: "user_left";
  user: CollabUser;
}

export interface CursorUpdateEvent extends BaseCollabEvent {
  type: "cursor_update";
  position: number;
  selectionStart?: number;
  selectionEnd?: number;
}

export interface TypingStartEvent extends BaseCollabEvent {
  type: "typing_start";
  user: CollabUser;
}

export interface TypingStopEvent extends BaseCollabEvent {
  type: "typing_stop";
  user: CollabUser;
}

export interface PresenceSyncEvent extends BaseCollabEvent {
  type: "presence_sync";
  users: CollabUser[];
}

export interface AnnotationAddedEvent extends BaseCollabEvent {
  type: "annotation_added";
  annotation: {
    id: string;
    messageId: string;
    parentId?: string;
    text: string;
    author: CollabUser;
    createdAt: number;
    resolved: boolean;
    replies: AnnotationReply[];
  };
}

export interface AnnotationResolvedEvent extends BaseCollabEvent {
  type: "annotation_resolved";
  annotationId: string;
  resolved: boolean;
  resolvedBy: CollabUser;
}

export interface AnnotationReplyEvent extends BaseCollabEvent {
  type: "annotation_reply";
  annotationId: string;
  reply: AnnotationReply;
}

export interface AnnotationReply {
  id: string;
  text: string;
  author: CollabUser;
  createdAt: number;
}

export interface RoleChangedEvent extends BaseCollabEvent {
  type: "role_changed";
  targetUserId: string;
  newRole: CollabRole;
}

export interface AccessRevokedEvent extends BaseCollabEvent {
  type: "access_revoked";
  targetUserId: string;
}

export interface OwnershipTransferredEvent extends BaseCollabEvent {
  type: "ownership_transferred";
  newOwnerId: string;
  previousOwnerId: string;
}

export interface SessionStateEvent extends BaseCollabEvent {
  type: "session_state";
  users: CollabUser[];
  pendingToolUseIds: string[];
  toolApprovalPolicy: "owner-only" | "any-collaborator";
}

export interface ErrorEvent extends BaseCollabEvent {
  type: "error";
  code: string;
  message: string;
}

export type CollabEvent =
  | MessageAddedEvent
  | MessageStreamingEvent
  | ToolUsePendingEvent
  | ToolUseApprovedEvent
  | ToolUseDeniedEvent
  | UserJoinedEvent
  | UserLeftEvent
  | CursorUpdateEvent
  | TypingStartEvent
  | TypingStopEvent
  | PresenceSyncEvent
  | AnnotationAddedEvent
  | AnnotationResolvedEvent
  | AnnotationReplyEvent
  | RoleChangedEvent
  | AccessRevokedEvent
  | OwnershipTransferredEvent
  | SessionStateEvent
  | ErrorEvent;

// Outgoing-only events (client → server) that don't need timestamp/sessionId
export type OutgoingEvent = Omit<CollabEvent, "timestamp">;

type EventHandler<T extends CollabEvent = CollabEvent> = (event: T) => void;

// ─── CollabSocket ─────────────────────────────────────────────────────────────

export class CollabSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<CollabEventType, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly baseDelay = 1000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private wsUrl = "";

  readonly sessionId: string;
  readonly token: string;
  isConnected = false;
  onConnectionChange?: (connected: boolean) => void;

  constructor(sessionId: string, token: string) {
    this.sessionId = sessionId;
    this.token = token;
  }

  connect(wsUrl: string): void {
    this.wsUrl = wsUrl;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const url = new URL(wsUrl);
    url.searchParams.set("sessionId", this.sessionId);
    url.searchParams.set("token", this.token);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.onConnectionChange?.(true);
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as CollabEvent;
        this.dispatch(data);
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this.onConnectionChange?.(false);
      this.stopPing();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    // Set max attempts to prevent reconnect
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  send(event: OutgoingEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ ...event, timestamp: Date.now() }));
  }

  on<T extends CollabEvent>(
    type: T["type"],
    handler: EventHandler<T>
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as EventHandler);
    return () => this.off(type, handler);
  }

  off<T extends CollabEvent>(type: T["type"], handler: EventHandler<T>): void {
    this.handlers.get(type)?.delete(handler as EventHandler);
  }

  private dispatch(event: CollabEvent): void {
    this.handlers.get(event.type)?.forEach((h) => h(event));
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      this.ws?.send(JSON.stringify({ type: "ping" }));
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(this.wsUrl), delay);
  }
}

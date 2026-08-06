"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { CollabSocket } from "@/lib/collaboration/socket";
import type {
  CollabUser,
  CollabRole,
  ToolUsePendingEvent,
  AnnotationAddedEvent,
  AnnotationReplyEvent,
} from "@/lib/collaboration/socket";
import type { CollabAnnotation, PendingToolUse } from "@/lib/collaboration/types";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface UseCollaborationOptions {
  sessionId: string;
  currentUser: CollabUser;
  wsUrl?: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

export interface CollaborationState {
  isConnected: boolean;
  myRole: CollabRole | null;
  pendingToolUses: PendingToolUse[];
  annotations: Record<string, CollabAnnotation[]>; // messageId → annotations
  toolApprovalPolicy: "owner-only" | "any-collaborator";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCollaboration({
  sessionId,
  currentUser,
  wsUrl,
}: UseCollaborationOptions) {
  const socketRef = useRef<CollabSocket | null>(null);
  const [state, setState] = useState<CollaborationState>({
    isConnected: false,
    myRole: null,
    pendingToolUses: [],
    annotations: {},
    toolApprovalPolicy: "any-collaborator",
  });

  const effectiveWsUrl =
    wsUrl ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001"
      : "ws://localhost:3001");

  useEffect(() => {
    const socket = new CollabSocket(sessionId, currentUser.id);
    socketRef.current = socket;

    socket.onConnectionChange = (connected) => {
      setState((s) => ({ ...s, isConnected: connected }));
    };

    const cleanup: Array<() => void> = [];

    cleanup.push(
      socket.on("session_state", (e) => {
        const me = e.users.find((u) => u.id === currentUser.id);
        setState((s) => ({
          ...s,
          myRole: me?.role ?? null,
          toolApprovalPolicy: e.toolApprovalPolicy,
        }));
      })
    );

    cleanup.push(
      socket.on("tool_use_pending", (e: ToolUsePendingEvent) => {
        const entry: PendingToolUse = {
          id: e.toolUseId,
          name: e.toolName,
          input: e.toolInput,
          messageId: e.messageId,
          requestedAt: e.timestamp,
        };
        setState((s) => ({
          ...s,
          pendingToolUses: [...s.pendingToolUses, entry],
        }));
      })
    );

    cleanup.push(
      socket.on("tool_use_approved", (e) => {
        setState((s) => ({
          ...s,
          pendingToolUses: s.pendingToolUses.filter((t) => t.id !== e.toolUseId),
        }));
      })
    );

    cleanup.push(
      socket.on("tool_use_denied", (e) => {
        setState((s) => ({
          ...s,
          pendingToolUses: s.pendingToolUses.filter((t) => t.id !== e.toolUseId),
        }));
      })
    );

    cleanup.push(
      socket.on("role_changed", (e) => {
        if (e.targetUserId === currentUser.id) {
          setState((s) => ({ ...s, myRole: e.newRole }));
        }
      })
    );

    cleanup.push(
      socket.on("access_revoked", (e) => {
        if (e.targetUserId === currentUser.id) {
          socket.disconnect();
          setState((s) => ({ ...s, isConnected: false, myRole: null }));
        }
      })
    );

    cleanup.push(
      socket.on("ownership_transferred", (e) => {
        if (e.newOwnerId === currentUser.id) {
          setState((s) => ({ ...s, myRole: "owner" }));
        } else if (e.previousOwnerId === currentUser.id) {
          setState((s) => ({ ...s, myRole: "collaborator" }));
        }
      })
    );

    cleanup.push(
      socket.on("annotation_added", (e: AnnotationAddedEvent) => {
        const ann: CollabAnnotation = { ...e.annotation };
        setState((s) => ({
          ...s,
          annotations: {
            ...s.annotations,
            [ann.messageId]: [...(s.annotations[ann.messageId] ?? []), ann],
          },
        }));
      })
    );

    cleanup.push(
      socket.on("annotation_resolved", (e) => {
        setState((s) => {
          const next: Record<string, CollabAnnotation[]> = {};
          for (const [msgId, anns] of Object.entries(s.annotations)) {
            next[msgId] = anns.map((a) =>
              a.id === e.annotationId ? { ...a, resolved: e.resolved } : a
            );
          }
          return { ...s, annotations: next };
        });
      })
    );

    cleanup.push(
      socket.on("annotation_reply", (e: AnnotationReplyEvent) => {
        setState((s) => {
          const next: Record<string, CollabAnnotation[]> = {};
          for (const [msgId, anns] of Object.entries(s.annotations)) {
            next[msgId] = anns.map((a) =>
              a.id === e.annotationId
                ? { ...a, replies: [...a.replies, e.reply] }
                : a
            );
          }
          return { ...s, annotations: next };
        });
      })
    );

    socket.connect(`${effectiveWsUrl}/collab`);

    return () => {
      cleanup.forEach((off) => off());
      socket.disconnect();
    };
  }, [sessionId, currentUser.id, effectiveWsUrl]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const approveTool = useCallback(
    (toolUseId: string) => {
      socketRef.current?.send({
        type: "tool_use_approved",
        sessionId,
        userId: currentUser.id,
        toolUseId,
        approvedBy: currentUser,
      });
    },
    [sessionId, currentUser]
  );

  const denyTool = useCallback(
    (toolUseId: string) => {
      socketRef.current?.send({
        type: "tool_use_denied",
        sessionId,
        userId: currentUser.id,
        toolUseId,
        deniedBy: currentUser,
      });
    },
    [sessionId, currentUser]
  );

  const addAnnotation = useCallback(
    (messageId: string, text: string, parentId?: string) => {
      const annotation: CollabAnnotation = {
        id: crypto.randomUUID(),
        messageId,
        parentId,
        text,
        author: currentUser,
        createdAt: Date.now(),
        resolved: false,
        replies: [],
      };
      // Optimistic update
      setState((s) => ({
        ...s,
        annotations: {
          ...s.annotations,
          [messageId]: [...(s.annotations[messageId] ?? []), annotation],
        },
      }));
      socketRef.current?.send({
        type: "annotation_added",
        sessionId,
        userId: currentUser.id,
        annotation,
      });
    },
    [sessionId, currentUser]
  );

  const resolveAnnotation = useCallback(
    (annotationId: string, resolved: boolean) => {
      setState((s) => {
        const next: Record<string, CollabAnnotation[]> = {};
        for (const [msgId, anns] of Object.entries(s.annotations)) {
          next[msgId] = anns.map((a) =>
            a.id === annotationId ? { ...a, resolved } : a
          );
        }
        return { ...s, annotations: next };
      });
      socketRef.current?.send({
        type: "annotation_resolved",
        sessionId,
        userId: currentUser.id,
        annotationId,
        resolved,
        resolvedBy: currentUser,
      });
    },
    [sessionId, currentUser]
  );

  const replyAnnotation = useCallback(
    (annotationId: string, text: string) => {
      const reply = {
        id: crypto.randomUUID(),
        text,
        author: currentUser,
        createdAt: Date.now(),
      };
      // Optimistic update
      setState((s) => {
        const next: Record<string, CollabAnnotation[]> = {};
        for (const [msgId, anns] of Object.entries(s.annotations)) {
          next[msgId] = anns.map((a) =>
            a.id === annotationId
              ? { ...a, replies: [...a.replies, reply] }
              : a
          );
        }
        return { ...s, annotations: next };
      });
      socketRef.current?.send({
        type: "annotation_reply",
        sessionId,
        userId: currentUser.id,
        annotationId,
        reply,
      });
    },
    [sessionId, currentUser]
  );

  const revokeAccess = useCallback(
    (targetUserId: string) => {
      socketRef.current?.send({
        type: "access_revoked",
        sessionId,
        userId: currentUser.id,
        targetUserId,
      });
    },
    [sessionId, currentUser.id]
  );

  const changeRole = useCallback(
    (targetUserId: string, newRole: CollabRole) => {
      socketRef.current?.send({
        type: "role_changed",
        sessionId,
        userId: currentUser.id,
        targetUserId,
        newRole,
      });
    },
    [sessionId, currentUser.id]
  );

  const transferOwnership = useCallback(
    (newOwnerId: string) => {
      socketRef.current?.send({
        type: "ownership_transferred",
        sessionId,
        userId: currentUser.id,
        newOwnerId,
        previousOwnerId: currentUser.id,
      });
    },
    [sessionId, currentUser.id]
  );

  return {
    ...state,
    approveTool,
    denyTool,
    addAnnotation,
    resolveAnnotation,
    replyAnnotation,
    revokeAccess,
    changeRole,
    transferOwnership,
  };
}

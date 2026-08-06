"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  createPresenceState,
  presenceAddUser,
  presenceRemoveUser,
  presenceSyncUsers,
  presenceUpdateCursor,
  presenceSetTyping,
} from "@/lib/collaboration/presence";
import type { PresenceState } from "@/lib/collaboration/presence";
import type { CollabSocket } from "@/lib/collaboration/socket";
import type { CollabUser } from "@/lib/collaboration/socket";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface UsePresenceOptions {
  socket: CollabSocket | null;
  sessionId: string;
  currentUser: CollabUser;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePresence({ socket, sessionId, currentUser }: UsePresenceOptions) {
  const [presence, setPresence] = useState<PresenceState>(createPresenceState);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!socket) return;
    const cleanup: Array<() => void> = [];

    cleanup.push(
      socket.on("presence_sync", (e) => {
        setPresence((s) => presenceSyncUsers(s, e.users));
      })
    );

    cleanup.push(
      socket.on("session_state", (e) => {
        setPresence((s) => presenceSyncUsers(s, e.users));
      })
    );

    cleanup.push(
      socket.on("user_joined", (e) => {
        setPresence((s) => presenceAddUser(s, e.user));
      })
    );

    cleanup.push(
      socket.on("user_left", (e) => {
        setPresence((s) => presenceRemoveUser(s, e.user.id));
      })
    );

    cleanup.push(
      socket.on("cursor_update", (e) => {
        if (e.userId === currentUser.id) return; // skip own cursor
        setPresence((s) =>
          presenceUpdateCursor(s, e.userId, e.position, e.selectionStart, e.selectionEnd)
        );
      })
    );

    cleanup.push(
      socket.on("typing_start", (e) => {
        if (e.userId === currentUser.id) return;
        setPresence((s) => presenceSetTyping(s, e.user.id, true));
      })
    );

    cleanup.push(
      socket.on("typing_stop", (e) => {
        if (e.userId === currentUser.id) return;
        setPresence((s) => presenceSetTyping(s, e.user.id, false));
      })
    );

    return () => cleanup.forEach((off) => off());
  }, [socket, currentUser.id]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const sendCursorUpdate = useCallback(
    (position: number, selectionStart?: number, selectionEnd?: number) => {
      socket?.send({
        type: "cursor_update",
        sessionId,
        userId: currentUser.id,
        position,
        selectionStart,
        selectionEnd,
      });
    },
    [socket, sessionId, currentUser.id]
  );

  // Call this whenever the user types — auto-sends typing_start + debounced typing_stop
  const notifyTyping = useCallback(() => {
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket?.send({
        type: "typing_start",
        sessionId,
        userId: currentUser.id,
        user: currentUser,
      });
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socket?.send({
        type: "typing_stop",
        sessionId,
        userId: currentUser.id,
        user: currentUser,
      });
    }, 2_000);
  }, [socket, sessionId, currentUser]);

  const stopTyping = useCallback(() => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (isTypingRef.current) {
      isTypingRef.current = false;
      socket?.send({
        type: "typing_stop",
        sessionId,
        userId: currentUser.id,
        user: currentUser,
      });
    }
  }, [socket, sessionId, currentUser]);

  // Derived helpers
  const otherUsers = Array.from(presence.users.values()).filter(
    (u) => u.id !== currentUser.id
  );
  const typingUsers = Array.from(presence.typing)
    .filter((id) => id !== currentUser.id)
    .map((id) => presence.users.get(id))
    .filter((u): u is CollabUser => u !== undefined);

  return {
    presence,
    otherUsers,
    typingUsers,
    sendCursorUpdate,
    notifyTyping,
    stopTyping,
  };
}

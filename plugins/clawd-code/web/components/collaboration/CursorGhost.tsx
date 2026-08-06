"use client";

import { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useCollaborationContextOptional } from "./CollaborationProvider";
import type { CursorState } from "@/lib/collaboration/presence";
import type { CollabUser } from "@/lib/collaboration/socket";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CursorGhostProps {
  /** The textarea ref to measure cursor positions against */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

interface RenderedCursor {
  user: CollabUser;
  cursor: CursorState;
  top: number;
  left: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Approximates pixel position of a text offset inside a textarea.
 * Uses a hidden mirror div that matches the textarea's styling.
 */
function measureCursorPosition(
  textarea: HTMLTextAreaElement,
  offset: number
): { top: number; left: number } {
  const mirror = document.createElement("div");
  const computed = window.getComputedStyle(textarea);

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.width = computed.width;
  mirror.style.font = computed.font;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.padding = computed.padding;
  mirror.style.border = computed.border;
  mirror.style.boxSizing = computed.boxSizing;

  const text = textarea.value.slice(0, offset);
  mirror.textContent = text;

  const span = document.createElement("span");
  span.textContent = "\u200b"; // zero-width space
  mirror.appendChild(span);

  document.body.appendChild(mirror);
  const rect = textarea.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  document.body.removeChild(mirror);

  return {
    top: spanRect.top - rect.top + textarea.scrollTop,
    left: spanRect.left - rect.left,
  };
}

// ─── CursorGhost ─────────────────────────────────────────────────────────────

export function CursorGhost({ textareaRef }: CursorGhostProps) {
  const ctx = useCollaborationContextOptional();
  const [rendered, setRendered] = useState<RenderedCursor[]>([]);

  useEffect(() => {
    if (!ctx || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const { presence, otherUsers } = ctx;

    const next: RenderedCursor[] = [];
    for (const user of otherUsers) {
      const cursor = presence.cursors.get(user.id);
      if (!cursor) continue;
      try {
        const pos = measureCursorPosition(textarea, cursor.position);
        next.push({ user, cursor, ...pos });
      } catch {
        // ignore measurement errors
      }
    }
    setRendered(next);
  });

  if (!ctx || rendered.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <AnimatePresence>
        {rendered.map(({ user, top, left }) => (
          <motion.div
            key={user.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute flex flex-col items-start"
            style={{ top, left }}
          >
            {/* Cursor caret */}
            <div
              className="w-0.5 h-4"
              style={{ backgroundColor: user.color }}
            />
            {/* Name tag */}
            <div
              className="px-1 py-0.5 rounded text-[9px] font-semibold text-white whitespace-nowrap"
              style={{ backgroundColor: user.color }}
            >
              {user.name}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

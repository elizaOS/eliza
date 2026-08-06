"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useCollaborationContextOptional } from "./CollaborationProvider";

// ─── Animated dots ────────────────────────────────────────────────────────────

function Dots() {
  return (
    <span className="inline-flex items-end gap-0.5 h-3">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-1 h-1 rounded-full bg-surface-400 inline-block"
          animate={{ y: [0, -3, 0] }}
          transition={{
            duration: 0.6,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  );
}

// ─── TypingIndicator ──────────────────────────────────────────────────────────

export function TypingIndicator() {
  const ctx = useCollaborationContextOptional();
  if (!ctx) return null;

  const { typingUsers } = ctx;
  if (typingUsers.length === 0) return null;

  let label: string;
  if (typingUsers.length === 1) {
    label = `${typingUsers[0].name} is typing`;
  } else if (typingUsers.length === 2) {
    label = `${typingUsers[0].name} and ${typingUsers[1].name} are typing`;
  } else {
    label = `${typingUsers.length} people are typing`;
  }

  return (
    <AnimatePresence>
      <motion.div
        key="typing-indicator"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.15 }}
        className="flex items-center gap-1.5 px-4 pb-1 text-xs text-surface-400"
      >
        {/* Colored dots for each typing user */}
        <span className="flex -space-x-1">
          {typingUsers.slice(0, 3).map((u) => (
            <span
              key={u.id}
              className="w-4 h-4 rounded-full border border-surface-900 flex items-center justify-center text-[8px] font-bold text-white"
              style={{ backgroundColor: u.color }}
            >
              {u.name[0].toUpperCase()}
            </span>
          ))}
        </span>
        <span>{label}</span>
        <Dots />
      </motion.div>
    </AnimatePresence>
  );
}

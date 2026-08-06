"use client";

import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnnotationThread } from "./AnnotationThread";
import { useCollaborationContextOptional } from "./CollaborationProvider";

interface AnnotationBadgeProps {
  messageId: string;
}

export function AnnotationBadge({ messageId }: AnnotationBadgeProps) {
  const ctx = useCollaborationContextOptional();
  const [open, setOpen] = useState(false);

  if (!ctx) return null;

  const annotations = ctx.annotations[messageId] ?? [];
  const unresolved = annotations.filter((a) => !a.resolved);
  if (annotations.length === 0) return null;

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium",
          "transition-colors border",
          unresolved.length > 0
            ? "bg-amber-900/30 border-amber-700/50 text-amber-300 hover:bg-amber-900/50"
            : "bg-surface-800 border-surface-700 text-surface-400 hover:bg-surface-700"
        )}
        title={`${annotations.length} comment${annotations.length !== 1 ? "s" : ""}`}
      >
        <MessageSquare className="w-3 h-3" />
        {unresolved.length > 0 ? unresolved.length : annotations.length}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-40 w-80"
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <AnnotationThread messageId={messageId} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

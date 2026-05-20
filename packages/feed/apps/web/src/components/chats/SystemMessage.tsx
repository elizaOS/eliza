"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import type { Message } from "./types";

interface SystemMessageProps {
  message: Message;
}

export function SystemMessage({ message }: SystemMessageProps) {
  const msgDate = new Date(message.createdAt);
  const action = message.metadata?.action;

  // If there's an action, render a more prominent alert-style message
  if (action) {
    return (
      <div className="flex justify-center py-2">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{message.content}</span>
          </div>
          <Link
            href={action.url}
            className="rounded-full bg-amber-500/20 px-3 py-1 font-medium text-amber-700 text-xs transition-colors hover:bg-amber-500/30 dark:text-amber-300"
          >
            {action.label}
          </Link>
        </div>
      </div>
    );
  }

  // Default simple system message style
  return (
    <div className="flex justify-center py-2">
      <div className="flex items-center gap-2 rounded-full bg-muted/50 px-3 py-1.5 text-muted-foreground text-xs">
        <span>{message.content}</span>
        <span className="opacity-60">·</span>
        <span className="opacity-60">
          {msgDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>
    </div>
  );
}

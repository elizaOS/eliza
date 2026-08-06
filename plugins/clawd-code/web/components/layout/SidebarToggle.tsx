"use client";

import { PanelLeft } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface SidebarToggleProps {
  className?: string;
}

export function SidebarToggle({ className }: SidebarToggleProps) {
  const { sidebarOpen, toggleSidebar } = useChatStore();

  return (
    <button
      onClick={toggleSidebar}
      title={sidebarOpen ? "Close sidebar (⌘B)" : "Open sidebar (⌘B)"}
      aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
      aria-expanded={sidebarOpen}
      className={cn(
        "p-1.5 rounded-md text-surface-400 hover:text-surface-100 hover:bg-surface-800 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        className
      )}
    >
      <PanelLeft className="w-4 h-4" aria-hidden="true" />
    </button>
  );
}

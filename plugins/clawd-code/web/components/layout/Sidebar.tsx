"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, FolderOpen, Settings, ChevronLeft, ChevronRight } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ChatHistory } from "./ChatHistory";
import { FileExplorer } from "./FileExplorer";
import { QuickActions } from "./QuickActions";

const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const COLLAPSED_WIDTH = 60;

type SidebarTab = "chats" | "history" | "files" | "settings";

const TABS: Array<{ id: SidebarTab; icon: React.ElementType; label: string }> = [
  { id: "chats", icon: MessageSquare, label: "Chats" },
  { id: "files", icon: FolderOpen, label: "Files" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const {
    sidebarOpen,
    sidebarWidth,
    sidebarTab,
    toggleSidebar,
    setSidebarWidth,
    setSidebarTab,
    openSettings,
  } = useChatStore();

  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      setIsResizing(true);
    },
    [sidebarWidth]
  );

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = e.clientX - resizeRef.current.startX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeRef.current.startWidth + delta));
      setSidebarWidth(next);
    };
    const onUp = () => setIsResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, setSidebarWidth]);

  // Global keyboard shortcut: Cmd/Ctrl+B
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar]);

  const handleTabClick = (id: SidebarTab) => {
    if (id === "settings") {
      openSettings();
      return;
    }
    if (!sidebarOpen) toggleSidebar();
    setSidebarTab(id);
  };

  return (
    <motion.aside
      className={cn(
        "hidden md:flex flex-col h-full bg-surface-900 border-r border-surface-800",
        "relative flex-shrink-0 z-20",
        isResizing && "select-none"
      )}
      animate={{ width: sidebarOpen ? sidebarWidth : COLLAPSED_WIDTH }}
      transition={{ duration: 0.2, ease: "easeInOut" }}
      aria-label="Navigation sidebar"
    >
      {/* Top bar: app name + tabs + collapse toggle */}
      <div
        className={cn(
          "flex border-b border-surface-800 flex-shrink-0",
          sidebarOpen ? "flex-row items-center" : "flex-col items-center py-2 gap-1"
        )}
      >
        {sidebarOpen && (
          <span className="flex-1 text-sm font-semibold text-surface-100 px-4 py-3 truncate">
            Clawd Code
          </span>
        )}

        <div
          className={cn(
            "flex",
            sidebarOpen
              ? "flex-row items-center gap-0.5 pr-1 py-1.5"
              : "flex-col w-full px-1.5 gap-0.5"
          )}
        >
          {TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => handleTabClick(id)}
              title={label}
              aria-label={label}
              className={cn(
                "flex items-center gap-2 rounded-md text-xs font-medium transition-colors",
                sidebarOpen ? "px-2.5 py-1.5" : "w-full justify-center px-0 py-2",
                sidebarOpen && sidebarTab === id && id !== "settings"
                  ? "bg-surface-800 text-surface-100"
                  : "text-surface-500 hover:text-surface-300 hover:bg-surface-800/60"
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              {sidebarOpen && <span>{label}</span>}
            </button>
          ))}
        </div>

        <button
          onClick={toggleSidebar}
          title={sidebarOpen ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          className={cn(
            "p-2 rounded-md text-surface-500 hover:text-surface-300 hover:bg-surface-800/60 transition-colors",
            sidebarOpen ? "mr-1" : "my-0.5"
          )}
        >
          {sidebarOpen ? (
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.div
            key={sidebarTab}
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
          >
            {(sidebarTab === "chats" || sidebarTab === "history") && <ChatHistory />}
            {sidebarTab === "files" && <FileExplorer />}
          </motion.div>
        )}
      </AnimatePresence>

      {sidebarOpen && <QuickActions />}

      {/* Drag-to-resize handle */}
      {sidebarOpen && (
        <div
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className={cn(
            "absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors",
            "hover:bg-brand-500/40",
            isResizing && "bg-brand-500/60"
          )}
        />
      )}
    </motion.aside>
  );
}

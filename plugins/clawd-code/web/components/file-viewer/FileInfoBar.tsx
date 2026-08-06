"use client";

import { Eye, Edit3, GitCompare } from "lucide-react";
import { useFileViewerStore, type FileTab, type FileViewMode } from "@/lib/fileViewerStore";
import { cn } from "@/lib/utils";

interface FileInfoBarProps {
  tab: FileTab;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  python: "Python",
  rust: "Rust",
  go: "Go",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  json: "JSON",
  markdown: "Markdown",
  bash: "Bash",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  graphql: "GraphQL",
  ruby: "Ruby",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  swift: "Swift",
  kotlin: "Kotlin",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  text: "Plain Text",
};

const VIEW_MODES: { mode: FileViewMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { mode: "view", label: "View", icon: Eye },
  { mode: "edit", label: "Edit", icon: Edit3 },
  { mode: "diff", label: "Diff", icon: GitCompare },
];

export function FileInfoBar({ tab }: FileInfoBarProps) {
  const { setMode } = useFileViewerStore();

  const lineCount = tab.content.split("\n").length;
  const byteSize = new TextEncoder().encode(tab.content).length;
  const langLabel = LANGUAGE_LABELS[tab.language] ?? tab.language;

  return (
    <div className="flex items-center justify-between px-3 py-1 border-t border-surface-800 bg-surface-950 text-xs text-surface-500">
      {/* Left: file stats */}
      <div className="flex items-center gap-3">
        <span className="text-surface-400">{langLabel}</span>
        <span>UTF-8</span>
        <span>{lineCount.toLocaleString()} lines</span>
        <span>{formatBytes(byteSize)}</span>
        {tab.isDirty && (
          <span className="text-yellow-500">● Unsaved changes</span>
        )}
      </div>

      {/* Right: mode switcher */}
      {!tab.isImage && (
        <div className="flex items-center gap-0.5 bg-surface-900 rounded px-1 py-0.5">
          {VIEW_MODES.map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              onClick={() => setMode(tab.id, mode)}
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors",
                tab.mode === mode
                  ? "bg-surface-700 text-surface-100"
                  : "text-surface-500 hover:text-surface-300"
              )}
              disabled={mode === "diff" && !tab.diff}
              title={mode === "diff" && !tab.diff ? "No diff available" : label}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

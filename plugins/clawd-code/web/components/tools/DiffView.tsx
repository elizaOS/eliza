"use client";

import { useState, useMemo } from "react";
import { Columns2, AlignLeft, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHighlightedCode } from "./SyntaxHighlight";

// ─── Diff algorithm ──────────────────────────────────────────────────────────

type DiffLineType = "equal" | "add" | "remove";

interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: Uint32Array[] = Array.from(
    { length: m + 1 },
    () => new Uint32Array(n + 1)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  let oldLineNo = m;
  let newLineNo = n;

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      oldLines[i - 1] === newLines[j - 1]
    ) {
      result.unshift({
        type: "equal",
        content: oldLines[i - 1],
        oldLineNo: oldLineNo--,
        newLineNo: newLineNo--,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: "add",
        content: newLines[j - 1],
        newLineNo: newLineNo--,
      });
      j--;
    } else {
      result.unshift({
        type: "remove",
        content: oldLines[i - 1],
        oldLineNo: oldLineNo--,
      });
      i--;
    }
  }

  return result;
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── Unified diff view ───────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

interface UnifiedDiffProps {
  lines: DiffLine[];
  lang: string;
}

function UnifiedDiff({ lines, lang: _lang }: UnifiedDiffProps) {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());

  // Identify collapsed regions (equal lines away from changes)
  const visible = useMemo(() => {
    const changed = new Set<number>();
    lines.forEach((l, i) => {
      if (l.type !== "equal") {
        for (
          let k = Math.max(0, i - CONTEXT_LINES);
          k <= Math.min(lines.length - 1, i + CONTEXT_LINES);
          k++
        ) {
          changed.add(k);
        }
      }
    });
    return changed;
  }, [lines]);

  const items: Array<
    | { kind: "line"; line: DiffLine; idx: number }
    | { kind: "hunk"; start: number; end: number; count: number }
  > = useMemo(() => {
    const result: typeof items = [];
    let i = 0;
    while (i < lines.length) {
      if (visible.has(i) || expandedHunks.has(i)) {
        result.push({ kind: "line", line: lines[i], idx: i });
        i++;
      } else {
        // Find the extent of the collapsed hunk
        let end = i;
        while (end < lines.length && !visible.has(end) && !expandedHunks.has(end)) {
          end++;
        }
        result.push({ kind: "hunk", start: i, end, count: end - i });
        i = end;
      }
    }
    return result;
  }, [lines, visible, expandedHunks]);

  return (
    <div className="font-mono text-xs leading-5 overflow-x-auto">
      <table className="w-full border-collapse">
        <tbody>
          {items.map((item, idx) => {
            if (item.kind === "hunk") {
              return (
                <tr key={`hunk-${idx}`}>
                  <td colSpan={3} className="bg-surface-800/50 text-center py-0.5">
                    <button
                      onClick={() => {
                        setExpandedHunks((prev) => {
                          const next = new Set(prev);
                          for (let k = item.start; k < item.end; k++) next.add(k);
                          return next;
                        });
                      }}
                      className="text-surface-400 hover:text-surface-200 text-xs px-2 py-0.5"
                    >
                      ↕ {item.count} unchanged line{item.count !== 1 ? "s" : ""}
                    </button>
                  </td>
                </tr>
              );
            }

            const { line } = item;
            const bgClass =
              line.type === "add"
                ? "bg-green-950/50 hover:bg-green-950/70"
                : line.type === "remove"
                ? "bg-red-950/50 hover:bg-red-950/70"
                : "hover:bg-surface-800/30";
            const prefixClass =
              line.type === "add"
                ? "text-green-400"
                : line.type === "remove"
                ? "text-red-400"
                : "text-surface-600";
            const prefix =
              line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";

            return (
              <tr key={`line-${idx}`} className={bgClass}>
                {/* Old line number */}
                <td className="select-none text-right text-surface-600 pr-2 pl-3 w-10 border-r border-surface-700/50">
                  {line.type !== "add" ? line.oldLineNo : ""}
                </td>
                {/* New line number */}
                <td className="select-none text-right text-surface-600 pr-2 pl-2 w-10 border-r border-surface-700/50">
                  {line.type !== "remove" ? line.newLineNo : ""}
                </td>
                {/* Content */}
                <td className="pl-3 pr-4 whitespace-pre">
                  <span className={cn("mr-2", prefixClass)}>{prefix}</span>
                  <span className="text-surface-100">{line.content}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Side-by-side diff ───────────────────────────────────────────────────────

interface SideBySideDiffProps {
  lines: DiffLine[];
}

function SideBySideDiff({ lines }: SideBySideDiffProps) {
  // Build paired columns: match adds to removes
  const pairs: Array<{
    left: DiffLine | null;
    right: DiffLine | null;
  }> = useMemo(() => {
    const result: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.type === "equal") {
        result.push({ left: line, right: line });
        i++;
      } else if (line.type === "remove") {
        // Pair with next add if exists
        const next = lines[i + 1];
        if (next?.type === "add") {
          result.push({ left: line, right: next });
          i += 2;
        } else {
          result.push({ left: line, right: null });
          i++;
        }
      } else {
        result.push({ left: null, right: line });
        i++;
      }
    }
    return result;
  }, [lines]);

  return (
    <div className="font-mono text-xs leading-5 overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-surface-500 border-b border-surface-700">
            <th colSpan={2} className="text-left pl-3 py-1 font-normal">
              Before
            </th>
            <th colSpan={2} className="text-left pl-3 py-1 font-normal border-l border-surface-700">
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair, idx) => (
            <tr key={idx}>
              {/* Left column */}
              <td
                className={cn(
                  "select-none text-right text-surface-600 pr-2 pl-3 w-10 border-r border-surface-700/50",
                  pair.left?.type === "remove" && "bg-red-950/50"
                )}
              >
                {pair.left?.oldLineNo ?? ""}
              </td>
              <td
                className={cn(
                  "pl-2 pr-3 whitespace-pre border-r border-surface-700",
                  pair.left?.type === "remove"
                    ? "bg-red-950/50 text-red-200"
                    : "text-surface-300"
                )}
              >
                {pair.left?.content ?? ""}
              </td>
              {/* Right column */}
              <td
                className={cn(
                  "select-none text-right text-surface-600 pr-2 pl-3 w-10 border-r border-surface-700/50",
                  pair.right?.type === "add" && "bg-green-950/50"
                )}
              >
                {pair.right?.newLineNo ?? ""}
              </td>
              <td
                className={cn(
                  "pl-2 pr-3 whitespace-pre",
                  pair.right?.type === "add"
                    ? "bg-green-950/50 text-green-200"
                    : "text-surface-300"
                )}
              >
                {pair.right?.content ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Public component ────────────────────────────────────────────────────────

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  lang?: string;
  defaultMode?: "unified" | "side-by-side";
  className?: string;
}

export function DiffView({
  oldContent,
  newContent,
  lang = "text",
  defaultMode = "unified",
  className,
}: DiffViewProps) {
  const [mode, setMode] = useState<"unified" | "side-by-side">(defaultMode);

  const lines = useMemo(
    () => computeDiff(oldContent, newContent),
    [oldContent, newContent]
  );

  const addCount = lines.filter((l) => l.type === "add").length;
  const removeCount = lines.filter((l) => l.type === "remove").length;

  return (
    <div className={cn("rounded-lg overflow-hidden border border-surface-700", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-800 border-b border-surface-700">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-green-400 font-mono">+{addCount}</span>
          <span className="text-red-400 font-mono">−{removeCount}</span>
        </div>
        <div className="flex items-center gap-1">
          <CopyButton text={newContent} />
          <div className="flex items-center rounded overflow-hidden border border-surface-700">
            <button
              onClick={() => setMode("unified")}
              className={cn(
                "px-2 py-1 text-xs flex items-center gap-1 transition-colors",
                mode === "unified"
                  ? "bg-brand-600 text-white"
                  : "text-surface-400 hover:text-surface-200 hover:bg-surface-700"
              )}
            >
              <AlignLeft className="w-3 h-3" />
              Unified
            </button>
            <button
              onClick={() => setMode("side-by-side")}
              className={cn(
                "px-2 py-1 text-xs flex items-center gap-1 transition-colors",
                mode === "side-by-side"
                  ? "bg-brand-600 text-white"
                  : "text-surface-400 hover:text-surface-200 hover:bg-surface-700"
              )}
            >
              <Columns2 className="w-3 h-3" />
              Side by side
            </button>
          </div>
        </div>
      </div>

      {/* Diff content */}
      <div className="bg-surface-900 overflow-auto max-h-[480px]">
        {mode === "unified" ? (
          <UnifiedDiff lines={lines} lang={lang} />
        ) : (
          <SideBySideDiff lines={lines} />
        )}
      </div>
    </div>
  );
}

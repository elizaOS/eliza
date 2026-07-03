/**
 * Read-only, per-file review of the real git change set a coding sub-agent
 * produced. Pure presentation: it parses the captured unified-diff string into
 * per-file sections and renders each line styled by prefix. No API calls, no
 * derived state beyond per-file collapse toggles.
 *
 * The change set originates server-side (orchestrator `WorkspaceChangeSet`,
 * captured from git at `task_complete`) and reaches the UI on a task session
 * record's `metadata.lastChangeSet`. This component only displays it.
 */

import { useMemo, useState } from "react";
import type { ChangeSetData } from "../../../api/client-types-cloud";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

export interface DiffReviewPanelProps {
  changeSet: ChangeSetData | undefined;
  className?: string;
}

type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

interface FileDiff {
  path: string;
  lines: DiffLine[];
}

function classifyLine(text: string): DiffLineKind {
  if (text.startsWith("@@")) return "hunk";
  if (
    text.startsWith("+++") ||
    text.startsWith("---") ||
    text.startsWith("diff --git") ||
    text.startsWith("index ") ||
    text.startsWith("new file") ||
    text.startsWith("deleted file") ||
    text.startsWith("rename ") ||
    text.startsWith("similarity ")
  ) {
    return "meta";
  }
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "remove";
  return "context";
}

/**
 * Derive the post-image path from a `diff --git a/<old> b/<new>` header,
 * falling back to the old path. Returns undefined for any other line.
 */
function pathFromGitHeader(line: string): string | undefined {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (!match) return undefined;
  return match[2] ?? match[1];
}

/**
 * Split a captured unified-diff string into per-file sections. Every file the
 * change set reports is represented even when its hunk text was omitted
 * (the server caps how many file diffs it serializes), so a reviewer still sees
 * the complete list of touched paths.
 */
function parseDiff(changeSet: ChangeSetData): FileDiff[] {
  const byPath = new Map<string, FileDiff>();
  const order: string[] = [];
  const ensure = (path: string): FileDiff => {
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, lines: [] };
      byPath.set(path, entry);
      order.push(path);
    }
    return entry;
  };

  let current: FileDiff | undefined;
  for (const raw of changeSet.diff ? changeSet.diff.split("\n") : []) {
    const headerPath = pathFromGitHeader(raw);
    if (headerPath) {
      current = ensure(headerPath);
    }
    if (current) {
      current.lines.push({ kind: classifyLine(raw), text: raw });
    }
  }

  // Every reported changed file gets a section even if no hunk was serialized.
  for (const path of changeSet.changedFiles) ensure(path);

  return order.map((path) => byPath.get(path) as FileDiff);
}

const LINE_TONE: Record<DiffLineKind, string> = {
  add: "text-success",
  remove: "text-destructive",
  hunk: "text-warning",
  meta: "text-muted-foreground",
  context: "text-foreground/80",
};

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed",
        LINE_TONE[line.kind],
      )}
    >
      {line.text === "" ? " " : line.text}
    </div>
  );
}

function FileSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  const hasHunks = file.lines.some(
    (line) => line.kind === "add" || line.kind === "remove",
  );
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card/40">
      <Button
        variant="ghost"
        onClick={() => setOpen((value) => !value)}
        className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-left text-[13px] font-medium text-foreground hover:bg-muted/30"
        aria-expanded={open}
      >
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="truncate font-mono">{file.path}</span>
      </Button>
      {open ? (
        <div className="border-t border-border bg-background/40 px-3 py-2">
          {hasHunks ? (
            file.lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are an immutable, never-reordered render — line index is the only stable identity
              <DiffLineRow key={`${file.path}:${index}`} line={line} />
            ))
          ) : (
            <div className="text-[12px] text-muted-foreground">
              No inline diff captured for this file.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DiffReviewPanel({
  changeSet,
  className,
}: DiffReviewPanelProps) {
  const files = useMemo(
    () => (changeSet ? parseDiff(changeSet) : []),
    [changeSet],
  );

  if (!changeSet || changeSet.changedFiles.length === 0) {
    return (
      <div className={cn("text-[13px] text-muted-foreground", className)}>
        No file changes captured for this task.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">Changes</span>
        {changeSet.diffStat ? (
          <span className="font-mono text-[12px] text-muted-foreground">
            {changeSet.diffStat}
          </span>
        ) : null}
      </div>

      {changeSet.truncated ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          This diff is truncated — some changes are not shown. Review the full
          change set in the workspace.
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {files.map((file) => (
          <FileSection key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}

import type { MessageExampleGroup } from "@elizaos/core";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useState,
} from "react";
import type { CharacterData } from "../../api/client-types-config";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/* ── Small plus icon used for inline "add" actions ───────────────── */
const PlusIconSvg = ({ className }: { className?: string }) => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M5 1.25v7.5M1.25 5h7.5" />
  </svg>
);

/* ── Small trash icon used for inline "remove" actions ───────────── */
const TrashIconSvg = ({ className }: { className?: string }) => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 11 11"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="M1.75 2.75h7.5M4 2.75V1.75h3v1M2.75 2.75l.4 6.75h4.7l.4-6.75" />
  </svg>
);

/* ── Small grip icon shown as drag affordance ───────────────────── */
const GripIconSvg = ({ className }: { className?: string }) => (
  <svg
    width="10"
    height="14"
    viewBox="0 0 10 14"
    fill="currentColor"
    aria-hidden="true"
    className={className}
  >
    <circle cx="3" cy="3" r="1" />
    <circle cx="3" cy="7" r="1" />
    <circle cx="3" cy="11" r="1" />
    <circle cx="7" cy="3" r="1" />
    <circle cx="7" cy="7" r="1" />
    <circle cx="7" cy="11" r="1" />
  </svg>
);

const compactIconBtn =
  "inline-flex h-7 w-7 items-center justify-center rounded-sm border border-border/35 text-muted transition-colors hover:border-border/70 hover:bg-bg-muted/70 hover:text-txt focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

/* ── Style section constants ─────────────────────────────────────── */
const STYLE_SECTION_KEYS = ["all"] as const;
const STYLE_SECTION_PLACEHOLDERS: Record<
  string,
  { key: string; defaultValue: string }
> = {
  all: {
    key: "charactereditor.StylePlaceholderAll",
    defaultValue: "Add a style rule",
  },
};
const STYLE_SECTION_EMPTY_STATES: Record<
  string,
  { key: string; defaultValue: string }
> = {
  all: {
    key: "charactereditor.StyleEmptyStateAll",
    defaultValue: "No style rules yet.",
  },
};

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getDuplicateIndices(items: string[]): Set<number> {
  const buckets = new Map<string, number[]>();
  items.forEach((item, index) => {
    const normalized = normalizeComparable(item);
    if (!normalized) return;
    buckets.set(normalized, [...(buckets.get(normalized) ?? []), index]);
  });
  return new Set(
    [...buckets.values()].filter((indices) => indices.length > 1).flat(),
  );
}

/* ── Types ────────────────────────────────────────────────────────── */

export interface CharacterIdentityPanelProps {
  bioText: string;
  handleFieldEdit: (field: string, value: unknown) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

export interface CharacterStylePanelProps {
  d: CharacterData;
  pendingStyleEntries: Record<string, string>;
  styleEntryDrafts: Record<string, string[]>;
  handlePendingStyleEntryChange: (key: string, value: string) => void;
  handleAddStyleEntry: (key: string) => void;
  handleRemoveStyleEntry: (key: string, index: number) => void;
  handleStyleEntryDraftChange: (
    key: string,
    index: number,
    value: string,
  ) => void;
  handleCommitStyleEntry: (key: string, index: number) => void;
  handleReorderStyleEntries: (key: string, items: string[]) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

export interface CharacterExamplesPanelProps {
  d: CharacterData;
  normalizedMessageExamples: MessageExampleGroup[];
  handleFieldEdit: (field: string, value: unknown) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

/* ── CharacterIdentityPanel ──────────────────────────────────────── */

export function CharacterIdentityPanel({
  bioText,
  handleFieldEdit,
  t,
}: CharacterIdentityPanelProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          {t("charactereditor.AboutMe", { defaultValue: "About Me" })}
        </span>
        <Textarea
          value={bioText}
          rows={8}
          placeholder={t("charactereditor.AboutMePlaceholder", {
            defaultValue: "Describe who your agent is...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("bio", e.target.value)
          }
          className="w-full resize-none min-h-[8rem] overflow-x-hidden rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-2 font-mono text-xs leading-relaxed text-txt focus-visible:border-accent/60 focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

/* ── CharacterStylePanel ─────────────────────────────────────────── */

export function CharacterStylePanel({
  d,
  pendingStyleEntries,
  styleEntryDrafts,
  handlePendingStyleEntryChange,
  handleAddStyleEntry,
  handleRemoveStyleEntry,
  handleStyleEntryDraftChange,
  handleCommitStyleEntry,
  handleReorderStyleEntries,
  t,
}: CharacterStylePanelProps) {
  const style = d.style;
  const [dragStyleIndex, setDragStyleIndex] = useState<{
    key: string;
    index: number;
  } | null>(null);

  const reorderStyle = (list: string[], from: number, to: number): string[] => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("charactereditor.StyleRulesHeader", {
              defaultValue: "Style Rules",
            })}
          </span>
          <p className="mt-1 text-xs text-muted">
            {t("charactereditor.StyleRulesHelp", {
              defaultValue:
                "Effective rules from style.all, grouped by intent for easier review.",
            })}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-5 min-h-0">
        {STYLE_SECTION_KEYS.map((key) => {
          const items = style?.[key] ?? [];
          const duplicateIndices = getDuplicateIndices(items);
          const itemOccurrences = new Map<string, number>();
          return (
            <div
              key={key}
              className="flex flex-col gap-2"
              data-testid={`style-section-${key}`}
            >
              {duplicateIndices.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="rounded-sm border border-warning/50 bg-warning/10 px-2 py-1 text-warning">
                    {duplicateIndices.size}{" "}
                    {t("charactereditor.PossibleDuplicates", {
                      defaultValue: "possible duplicates",
                    })}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                {items.length > 0 ? (
                  items.map((item, index) => {
                    const comparableKey = normalizeComparable(item) || item;
                    const occurrence =
                      (itemOccurrences.get(comparableKey) ?? 0) + 1;
                    itemOccurrences.set(comparableKey, occurrence);
                    const isDragging =
                      dragStyleIndex?.key === key &&
                      dragStyleIndex.index === index;
                    const isDuplicate = duplicateIndices.has(index);
                    return (
                      <fieldset
                        key={`${key}:${comparableKey}:${occurrence}`}
                        draggable
                        onDragStart={(e: DragEvent<HTMLFieldSetElement>) => {
                          setDragStyleIndex({ key, index });
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e: DragEvent<HTMLFieldSetElement>) => {
                          if (
                            dragStyleIndex === null ||
                            dragStyleIndex.key !== key ||
                            dragStyleIndex.index === index
                          )
                            return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(e: DragEvent<HTMLFieldSetElement>) => {
                          e.preventDefault();
                          if (
                            dragStyleIndex === null ||
                            dragStyleIndex.key !== key ||
                            dragStyleIndex.index === index
                          )
                            return;
                          handleReorderStyleEntries(
                            key,
                            reorderStyle(items, dragStyleIndex.index, index),
                          );
                          setDragStyleIndex(null);
                        }}
                        onDragEnd={() => setDragStyleIndex(null)}
                        className={`group flex min-w-0 items-center gap-2 px-0 py-1 transition-opacity ${
                          isDuplicate ? "" : ""
                        } ${isDragging ? "opacity-40" : ""}`}
                      >
                        <span
                          className="shrink-0 text-muted opacity-60 cursor-grab active:cursor-grabbing select-none"
                          aria-hidden="true"
                          title={t("charactereditor.DragToReorder", {
                            defaultValue: "Drag to reorder",
                          })}
                        >
                          <GripIconSvg />
                        </span>
                        <Input
                          value={styleEntryDrafts[key]?.[index] ?? item}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            handleStyleEntryDraftChange(
                              key,
                              index,
                              e.target.value,
                            )
                          }
                          onBlur={() => handleCommitStyleEntry(key, index)}
                          aria-label={`${t(
                            `charactereditor.StyleRules.${key}`,
                            {
                              defaultValue: "Style rule",
                            },
                          )} ${index + 1}`}
                          className={`h-8 min-w-0 flex-1 rounded-none border-0 border-b bg-transparent px-0 text-sm text-txt focus-visible:ring-0 ${
                            isDuplicate
                              ? "border-warning/60 focus-visible:border-warning"
                              : "border-border/30 focus-visible:border-accent/60"
                          }`}
                        />
                        {isDuplicate ? (
                          <span className="shrink-0 rounded-sm bg-warning/15 px-1.5 py-0.5 text-[0.68rem] font-medium text-warning">
                            {t("charactereditor.DuplicateRule", {
                              defaultValue: "duplicate",
                            })}
                          </span>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted opacity-0 transition-colors hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => handleRemoveStyleEntry(key, index)}
                          title={t("common.remove")}
                          aria-label={`${t("common.remove")} ${t(
                            `charactereditor.StyleRules.${key}`,
                            {
                              defaultValue: "style rule",
                            },
                          )} ${index + 1}`}
                        >
                          <TrashIconSvg />
                        </Button>
                      </fieldset>
                    );
                  })
                ) : (
                  <div className="rounded-md border border-dashed border-border/40 bg-bg-muted/20 px-3 py-4 text-sm text-muted">
                    {t(STYLE_SECTION_EMPTY_STATES[key].key, {
                      defaultValue:
                        STYLE_SECTION_EMPTY_STATES[key].defaultValue,
                    })}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={pendingStyleEntries[key]}
                  placeholder={t(STYLE_SECTION_PLACEHOLDERS[key].key, {
                    defaultValue: STYLE_SECTION_PLACEHOLDERS[key].defaultValue,
                  })}
                  onChange={(
                    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
                  ) => handlePendingStyleEntryChange(key, e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddStyleEntry(key);
                    }
                  }}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border/40 bg-bg/70 px-3 text-sm text-txt outline-none focus:border-accent"
                />
                <button
                  type="button"
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-accent/35 px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  onClick={() => handleAddStyleEntry(key)}
                  disabled={!pendingStyleEntries[key].trim()}
                  title={t("charactereditor.AddStyleRule", {
                    defaultValue: "Add style rule",
                  })}
                  aria-label={t("charactereditor.AddStyleRule", {
                    defaultValue: "Add style rule",
                  })}
                >
                  <PlusIconSvg />
                  {t("charactereditor.AddStyleRuleShort", {
                    defaultValue: "Add rule",
                  })}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── CharacterExamplesPanel ──────────────────────────────────────── */

export function CharacterExamplesPanel({
  d,
  normalizedMessageExamples,
  handleFieldEdit,
  t,
}: CharacterExamplesPanelProps) {
  const [dragPostIndex, setDragPostIndex] = useState<number | null>(null);
  const postExamples = d.postExamples ?? [];
  const duplicatePostIndices = getDuplicateIndices(postExamples);

  const reorder = <T,>(list: T[], from: number, to: number): T[] => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Chat Examples */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
              {t("charactereditor.ChatExamples", {
                defaultValue: "Chat Examples",
              })}
            </span>
            <p className="mt-1 text-xs text-muted">
              {t("charactereditor.ChatExamplesHelp", {
                defaultValue:
                  "Example conversations grouped by channel and speaker.",
              })}
            </p>
          </div>
          <span className="rounded-sm border border-border/40 px-2 py-1 text-xs text-muted">
            {normalizedMessageExamples.length}{" "}
            {t("charactereditor.ConversationCount", {
              defaultValue: "conversations",
            })}
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {normalizedMessageExamples.map((convo, ci) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
              key={`convo-${ci}`}
              className="group/convo flex flex-col gap-2 rounded-md border border-border/35 bg-bg-muted/15 p-3"
            >
              {convo.examples.map((msg, mi) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
                  key={`msg-${ci}-${mi}`}
                  className="grid min-w-0 grid-cols-[4.5rem_1fr] items-start gap-2"
                >
                  <span
                    className={`mt-2 px-2 py-1 text-center text-[0.68rem] font-semibold uppercase tracking-[0.06em] ${
                      msg.name === "{{user1}}" ? "text-muted" : "text-accent"
                    }`}
                  >
                    {msg.name === "{{user1}}" ? "user" : "agent"}
                  </span>
                  <Textarea
                    value={msg.content?.text ?? ""}
                    rows={2}
                    aria-label={`${msg.name === "{{user1}}" ? "User" : "Agent"} message, conversation ${ci + 1}, turn ${mi + 1}`}
                    onChange={(e) => {
                      const updated = [...normalizedMessageExamples];
                      const convoClone = {
                        examples: [...updated[ci].examples],
                      };
                      convoClone.examples[mi] = {
                        ...convoClone.examples[mi],
                        content: { text: e.target.value },
                      };
                      updated[ci] = convoClone;
                      handleFieldEdit("messageExamples", updated);
                    }}
                    className="min-h-[3rem] w-full resize-none rounded-sm border border-border/30 bg-bg/70 px-2 py-1.5 text-sm leading-relaxed text-txt focus-visible:border-accent/60 focus-visible:ring-0"
                  />
                </div>
              ))}
              <div className="mt-1 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-border/40 px-2.5 text-xs font-medium text-txt transition-colors hover:bg-bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                  onClick={() => {
                    const agentName =
                      typeof d.name === "string" && d.name.trim()
                        ? d.name.trim()
                        : "Agent";
                    const updated = [...normalizedMessageExamples];
                    const convoClone = {
                      examples: [
                        ...updated[ci].examples,
                        { name: "{{user1}}", content: { text: "" } },
                        { name: agentName, content: { text: "" } },
                      ],
                    };
                    updated[ci] = convoClone;
                    handleFieldEdit("messageExamples", updated);
                  }}
                  title={t("charactereditor.AddTurn", {
                    defaultValue: "Add turn",
                  })}
                  aria-label={t("charactereditor.AddTurn", {
                    defaultValue: "Add turn",
                  })}
                >
                  <PlusIconSvg />
                  {t("charactereditor.AddTurn", {
                    defaultValue: "Add turn",
                  })}
                </button>
                <button
                  type="button"
                  className={compactIconBtn}
                  onClick={() => {
                    const updated = [...normalizedMessageExamples];
                    updated.splice(ci, 1);
                    handleFieldEdit("messageExamples", updated);
                  }}
                  title={t("charactereditor.RemoveExample", {
                    defaultValue: "Remove conversation",
                  })}
                  aria-label={`${t("common.remove")} conversation ${ci + 1}`}
                >
                  <TrashIconSvg />
                </button>
              </div>
            </div>
          ))}
          {normalizedMessageExamples.length === 0 && (
            <div className="rounded-md border border-dashed border-border/40 bg-bg-muted/20 px-3 py-4 text-sm text-muted">
              {t("charactereditor.NoChatExamples", {
                defaultValue: "No chat examples yet.",
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          className="inline-flex h-9 self-start items-center gap-2 rounded-md border border-accent/35 px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
          onClick={() => {
            const agentName =
              typeof d.name === "string" && d.name.trim()
                ? d.name.trim()
                : "Agent";
            const updated = [
              ...normalizedMessageExamples,
              {
                examples: [
                  { name: "{{user1}}", content: { text: "" } },
                  { name: agentName, content: { text: "" } },
                ],
              },
            ];
            handleFieldEdit("messageExamples", updated);
          }}
          title={t("charactereditor.AddConversation", {
            defaultValue: "Add conversation",
          })}
          aria-label={t("charactereditor.AddConversation", {
            defaultValue: "Add conversation",
          })}
        >
          <PlusIconSvg />
          {t("charactereditor.AddConversation", {
            defaultValue: "Add conversation",
          })}
        </button>
      </section>

      {/* Post Examples */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
              {t("charactereditor.PostExamples", {
                defaultValue: "Post Examples",
              })}
            </span>
            <p className="mt-1 text-xs text-muted">
              {t("charactereditor.PostExamplesHelp", {
                defaultValue: "Standalone post examples for social channels.",
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-sm border border-border/40 px-2 py-1">
              {postExamples.length}{" "}
              {t("charactereditor.PostCount", {
                defaultValue: "posts",
              })}
            </span>
            {duplicatePostIndices.size > 0 ? (
              <span className="rounded-sm border border-warning/50 bg-warning/10 px-2 py-1 text-warning">
                {duplicatePostIndices.size}{" "}
                {t("charactereditor.PossibleDuplicates", {
                  defaultValue: "possible duplicates",
                })}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {postExamples.map((post, pi) => {
            const isDragging = dragPostIndex === pi;
            const isDuplicate = duplicatePostIndices.has(pi);
            return (
              <fieldset
                // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
                key={`post-${pi}`}
                draggable
                onDragStart={(e: DragEvent<HTMLFieldSetElement>) => {
                  setDragPostIndex(pi);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e: DragEvent<HTMLFieldSetElement>) => {
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e: DragEvent<HTMLFieldSetElement>) => {
                  e.preventDefault();
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  handleFieldEdit(
                    "postExamples",
                    reorder(postExamples, dragPostIndex, pi),
                  );
                  setDragPostIndex(null);
                }}
                onDragEnd={() => setDragPostIndex(null)}
                className={`group flex min-w-0 items-start gap-2 rounded-md border p-2.5 transition-opacity ${
                  isDuplicate
                    ? "border-warning/50 bg-warning/5"
                    : "border-border/35 bg-bg-muted/15"
                } ${isDragging ? "opacity-40" : ""}`}
              >
                <span
                  className="mt-2 text-muted opacity-60 cursor-grab active:cursor-grabbing select-none"
                  aria-hidden="true"
                  title={t("charactereditor.DragToReorder", {
                    defaultValue: "Drag to reorder",
                  })}
                >
                  <GripIconSvg />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-accent">
                      {t("charactereditor.PostExample", {
                        defaultValue: "Post",
                      })}{" "}
                      #{pi + 1}
                    </span>
                    {isDuplicate ? (
                      <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[0.68rem] font-medium text-warning">
                        {t("charactereditor.DuplicatePost", {
                          defaultValue: "duplicate",
                        })}
                      </span>
                    ) : null}
                  </div>
                  <Textarea
                    value={post}
                    rows={3}
                    aria-label={`Post example ${pi + 1}`}
                    onChange={(e) => {
                      const updated = [...postExamples];
                      updated[pi] = e.target.value;
                      handleFieldEdit("postExamples", updated);
                    }}
                    className="min-h-[4.25rem] w-full resize-none rounded-sm border border-border/30 bg-bg/70 px-2 py-1.5 text-sm leading-relaxed text-txt focus-visible:border-accent/60 focus-visible:ring-0"
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-sm border border-border/35 p-0 text-muted transition-colors hover:border-danger/45 hover:bg-danger/10 hover:text-danger"
                    onClick={() => {
                      const updated = [...postExamples];
                      updated.splice(pi, 1);
                      handleFieldEdit("postExamples", updated);
                    }}
                    aria-label={`${t("common.remove")} post ${pi + 1}`}
                    title={t("charactereditor.RemovePost", {
                      defaultValue: "Remove post",
                    })}
                  >
                    <TrashIconSvg />
                  </Button>
                </div>
              </fieldset>
            );
          })}
          {postExamples.length === 0 && (
            <div className="rounded-md border border-dashed border-border/40 bg-bg-muted/20 px-3 py-4 text-sm text-muted">
              {t("charactereditor.NoPostExamples", {
                defaultValue: "No post examples yet.",
              })}
            </div>
          )}
          <button
            type="button"
            className="mt-1 inline-flex h-9 self-start items-center gap-2 rounded-md border border-accent/35 px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            onClick={() => {
              const updated = [...postExamples, ""];
              handleFieldEdit("postExamples", updated);
            }}
            title={t("charactereditor.AddPost", {
              defaultValue: "Add Post",
            })}
            aria-label={t("charactereditor.AddPost", {
              defaultValue: "Add Post",
            })}
          >
            <PlusIconSvg />
            {t("charactereditor.AddPost", {
              defaultValue: "Add Post",
            })}
          </button>
        </div>
      </section>
    </div>
  );
}

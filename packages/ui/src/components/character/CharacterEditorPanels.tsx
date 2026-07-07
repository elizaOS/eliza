/**
 * The three editable panels of the character editor — identity, style, and
 * message examples — split out from CharacterEditor/CharacterHubView so each is
 * independently composable and story-testable. Each is a controlled component:
 * it renders the given draft and reports edits upward; it owns no fetches.
 */
import type { MessageExampleGroup } from "@elizaos/core";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
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
  "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted transition-colors hover:bg-bg-muted/70 hover:text-txt disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

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
  nameText: string;
  systemText: string;
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
  nameText,
  systemText,
  bioText,
  handleFieldEdit,
  t,
}: CharacterIdentityPanelProps) {
  const { ref: nameRef, agentProps: nameAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "identity-name",
      role: "text-input",
      label: t("common.name", { defaultValue: "Name" }),
      group: "identity",
      description: "Edit the agent's name",
      getValue: () => nameText,
      onFill: (value) => handleFieldEdit("name", value),
    });
  const { ref: systemRef, agentProps: systemAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "identity-system-prompt",
      role: "textarea",
      label: t("settings.identity.systemPromptLabel", {
        defaultValue: "System prompt",
      }),
      group: "identity",
      description: "Edit the agent's system prompt / personality",
      getValue: () => systemText,
      onFill: (value) => handleFieldEdit("system", value),
    });
  const { ref: bioRef, agentProps: bioAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "identity-bio",
      role: "textarea",
      label: t("charactereditor.AboutMe", { defaultValue: "About Me" }),
      group: "identity",
      description: "Edit the agent's bio / about-me description",
      getValue: () => bioText,
      onFill: (value) => handleFieldEdit("bio", value),
    });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted">
          {t("common.name", { defaultValue: "Name" })}
        </span>
        <Input
          ref={nameRef}
          value={nameText}
          placeholder={t("startupshell.AgentName", {
            defaultValue: "Agent name",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            handleFieldEdit("name", e.target.value)
          }
          className="h-9 w-full rounded-none border-0 border-b border-border/40 bg-transparent px-0 text-sm text-txt"
          {...nameAgentProps}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted">
          {t("settings.identity.systemPromptLabel", {
            defaultValue: "System prompt",
          })}
        </span>
        <Textarea
          ref={systemRef}
          value={systemText}
          rows={3}
          placeholder={t("charactereditor.SystemPromptPlaceholder", {
            defaultValue: "Write in first person...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("system", e.target.value)
          }
          className="w-full resize-none min-h-[5rem] overflow-x-hidden rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-2 font-mono text-xs leading-relaxed text-txt sm:min-h-[10rem] lg:min-h-[14rem]"
          {...systemAgentProps}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted">
          {t("charactereditor.AboutMe", { defaultValue: "About Me" })}
        </span>
        <Textarea
          ref={bioRef}
          value={bioText}
          rows={2}
          placeholder={t("charactereditor.AboutMePlaceholder", {
            defaultValue: "Describe who your agent is...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("bio", e.target.value)
          }
          className="w-full resize-none min-h-[3.5rem] overflow-x-hidden rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-2 font-mono text-xs leading-relaxed text-txt sm:min-h-[6rem] lg:min-h-[8rem]"
          {...bioAgentProps}
        />
      </div>
    </div>
  );
}

/* ── CharacterStylePanel ─────────────────────────────────────────── */

function StyleRuleRow({
  sectionKey,
  index,
  value,
  isDuplicate,
  isDragging,
  draftValue,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onDraftChange,
  onCommit,
  onRemove,
  t,
}: {
  sectionKey: string;
  index: number;
  value: string;
  isDuplicate: boolean;
  isDragging: boolean;
  draftValue: string;
  onDragStart: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDragOver: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDrop: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDragEnd: () => void;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onRemove: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const ruleLabel = `${t(`charactereditor.StyleRules.${sectionKey}`, {
    defaultValue: "Style rule",
  })} ${index + 1}`;
  const { ref: inputRef, agentProps: inputAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `style-rule-${sectionKey}-${index}`,
      role: "text-input",
      label: ruleLabel,
      group: "style-rules",
      description: `Edit ${ruleLabel}`,
      getValue: () => draftValue,
      onFill: onDraftChange,
    });
  const { ref: removeRef, agentProps: removeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `style-rule-remove-${sectionKey}-${index}`,
      role: "button",
      label: `${t("common.remove")} ${ruleLabel}`,
      group: "style-rules",
      description: `Remove ${ruleLabel}`,
      onActivate: onRemove,
    });
  return (
    <fieldset
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex min-w-0 items-center gap-2 px-0 py-1 transition-opacity ${isDragging ? "opacity-40" : ""}`}
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
        ref={inputRef}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onDraftChange(e.target.value)
        }
        onBlur={onCommit}
        aria-label={ruleLabel}
        className={`h-8 min-w-0 flex-1 rounded-none border-0 border-b bg-transparent px-0 text-sm text-txt ${
          isDuplicate ? "border-warning/60 " : "border-border/30 "
        }`}
        {...inputAgentProps}
      />
      {isDuplicate ? (
        <span className="shrink-0 text-[0.68rem] font-medium text-warning">
          {t("charactereditor.DuplicateRule", {
            defaultValue: "duplicate",
          })}
        </span>
      ) : null}
      <Button
        ref={removeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted opacity-0 transition-colors hover:text-danger group-hover:opacity-100 "
        onClick={onRemove}
        title={t("common.remove")}
        aria-label={`${t("common.remove")} ${ruleLabel}`}
        {...removeAgentProps}
      >
        <TrashIconSvg />
      </Button>
    </fieldset>
  );
}

function StyleAddRow({
  sectionKey,
  pendingValue,
  onChange,
  onAdd,
  t,
}: {
  sectionKey: string;
  pendingValue: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const placeholder = t(STYLE_SECTION_PLACEHOLDERS[sectionKey].key, {
    defaultValue: STYLE_SECTION_PLACEHOLDERS[sectionKey].defaultValue,
  });
  const addLabel = t("charactereditor.AddStyleRule", {
    defaultValue: "Add style rule",
  });
  const { ref: inputRef, agentProps: inputAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `style-add-input-${sectionKey}`,
      role: "text-input",
      label: placeholder,
      group: "style-rules",
      description: "New style rule to add",
      getValue: () => pendingValue,
      onFill: onChange,
    });
  const { ref: addRef, agentProps: addAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `style-add-${sectionKey}`,
      role: "button",
      label: addLabel,
      group: "style-rules",
      description: "Add the pending style rule",
      onActivate: onAdd,
    });
  return (
    <div className="flex items-center gap-2">
      <Input
        ref={inputRef}
        type="text"
        value={pendingValue}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          onChange(e.target.value)
        }
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        className="h-9 min-w-0 flex-1 rounded-none border-0 border-b border-border/30 bg-transparent px-0 text-sm text-txt outline-none"
        {...inputAgentProps}
      />
      <Button
        ref={addRef}
        variant="ghost"
        size="sm"
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-sm px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={onAdd}
        disabled={!pendingValue.trim()}
        title={addLabel}
        aria-label={addLabel}
        {...addAgentProps}
      >
        <PlusIconSvg />
        {t("charactereditor.AddStyleRuleShort", {
          defaultValue: "Add rule",
        })}
      </Button>
    </div>
  );
}

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
    /* Flat — no card/border. The shell owns the page's horizontal padding. */
    <section className="flex flex-col gap-4">
      <span className="text-xs font-medium text-muted">
        {t("charactereditor.StyleRulesHeader", {
          defaultValue: "Style Rules",
        })}
      </span>
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
                <span className="text-xs text-warning">
                  {duplicateIndices.size}{" "}
                  {t("charactereditor.PossibleDuplicates", {
                    defaultValue: "possible duplicates",
                  })}
                </span>
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
                      <StyleRuleRow
                        key={`${key}:${comparableKey}:${occurrence}`}
                        sectionKey={key}
                        index={index}
                        value={styleEntryDrafts[key]?.[index] ?? item}
                        draftValue={styleEntryDrafts[key]?.[index] ?? item}
                        isDuplicate={isDuplicate}
                        isDragging={isDragging}
                        onDragStart={(e) => {
                          setDragStyleIndex({ key, index });
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          if (
                            dragStyleIndex === null ||
                            dragStyleIndex.key !== key ||
                            dragStyleIndex.index === index
                          )
                            return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(e) => {
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
                        onDraftChange={(value) =>
                          handleStyleEntryDraftChange(key, index, value)
                        }
                        onCommit={() => handleCommitStyleEntry(key, index)}
                        onRemove={() => handleRemoveStyleEntry(key, index)}
                        t={t}
                      />
                    );
                  })
                ) : (
                  <div className="py-4 text-sm text-muted">
                    {t(STYLE_SECTION_EMPTY_STATES[key].key, {
                      defaultValue:
                        STYLE_SECTION_EMPTY_STATES[key].defaultValue,
                    })}
                  </div>
                )}
              </div>
              <StyleAddRow
                sectionKey={key}
                pendingValue={pendingStyleEntries[key]}
                onChange={(value) => handlePendingStyleEntryChange(key, value)}
                onAdd={() => handleAddStyleEntry(key)}
                t={t}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── CharacterExamplesPanel ──────────────────────────────────────── */

function ConversationTurnTextarea({
  ci,
  mi,
  isUser,
  value,
  onChange,
}: {
  ci: number;
  mi: number;
  isUser: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const speaker = isUser ? "User" : "Agent";
  const label = `${speaker} message, conversation ${ci + 1}, turn ${mi + 1}`;
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: `example-message-${ci}-${mi}`,
    role: "textarea",
    label,
    group: "chat-examples",
    description: `Edit ${label}`,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Textarea
      ref={ref}
      value={value}
      rows={2}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-[3rem] w-full resize-none rounded-none border-0 border-b border-border/30 bg-transparent px-0 py-1.5 text-sm leading-relaxed text-txt"
      {...agentProps}
    />
  );
}

function ConversationFooter({
  ci,
  onAddTurn,
  onRemove,
  t,
}: {
  ci: number;
  onAddTurn: () => void;
  onRemove: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const addTurnLabel = t("charactereditor.AddTurn", {
    defaultValue: "Add turn",
  });
  const { ref: addTurnRef, agentProps: addTurnAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `example-add-turn-${ci}`,
      role: "button",
      label: `${addTurnLabel} (conversation ${ci + 1})`,
      group: "chat-examples",
      description: `Add a turn to conversation ${ci + 1}`,
      onActivate: onAddTurn,
    });
  const { ref: removeRef, agentProps: removeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `example-remove-conversation-${ci}`,
      role: "button",
      label: `${t("common.remove")} conversation ${ci + 1}`,
      group: "chat-examples",
      description: `Remove conversation ${ci + 1}`,
      onActivate: onRemove,
    });
  return (
    <div className="mt-1 flex items-center justify-end gap-2">
      <Button
        ref={addTurnRef}
        variant="ghost"
        size="sm"
        className="inline-flex h-8 items-center gap-2 rounded-sm px-2.5 text-xs font-medium text-txt transition-colors hover:bg-bg-muted/70"
        onClick={onAddTurn}
        title={addTurnLabel}
        aria-label={addTurnLabel}
        {...addTurnAgentProps}
      >
        <PlusIconSvg />
        {addTurnLabel}
      </Button>
      <Button
        ref={removeRef}
        variant="ghost"
        size="icon-sm"
        className={compactIconBtn}
        onClick={onRemove}
        title={t("charactereditor.RemoveExample", {
          defaultValue: "Remove conversation",
        })}
        aria-label={`${t("common.remove")} conversation ${ci + 1}`}
        {...removeAgentProps}
      >
        <TrashIconSvg />
      </Button>
    </div>
  );
}

function PostExampleRow({
  pi,
  post,
  isDuplicate,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onChange,
  onRemove,
  t,
}: {
  pi: number;
  post: string;
  isDuplicate: boolean;
  isDragging: boolean;
  onDragStart: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDragOver: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDrop: (e: DragEvent<HTMLFieldSetElement>) => void;
  onDragEnd: () => void;
  onChange: (value: string) => void;
  onRemove: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}) {
  const postLabel = `Post example ${pi + 1}`;
  const { ref: textRef, agentProps: textAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: `post-example-${pi}`,
      role: "textarea",
      label: postLabel,
      group: "post-examples",
      description: `Edit ${postLabel}`,
      getValue: () => post,
      onFill: onChange,
    });
  const { ref: removeRef, agentProps: removeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `post-example-remove-${pi}`,
      role: "button",
      label: `${t("common.remove")} post ${pi + 1}`,
      group: "post-examples",
      description: `Remove ${postLabel}`,
      onActivate: onRemove,
    });
  return (
    <fieldset
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex min-w-0 items-start gap-2 py-2.5 transition-opacity ${isDragging ? "opacity-40" : ""}`}
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
            <span className="text-[0.68rem] font-medium text-warning">
              {t("charactereditor.DuplicatePost", {
                defaultValue: "duplicate",
              })}
            </span>
          ) : null}
        </div>
        <Textarea
          ref={textRef}
          value={post}
          rows={3}
          aria-label={postLabel}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[4.25rem] w-full resize-none rounded-none border-0 border-b border-border/30 bg-transparent px-0 py-1.5 text-sm leading-relaxed text-txt"
          {...textAgentProps}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <Button
          ref={removeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          onClick={onRemove}
          aria-label={`${t("common.remove")} post ${pi + 1}`}
          title={t("charactereditor.RemovePost", {
            defaultValue: "Remove post",
          })}
          {...removeAgentProps}
        >
          <TrashIconSvg />
        </Button>
      </div>
    </fieldset>
  );
}

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

  const addConversationLabel = t("charactereditor.AddConversation", {
    defaultValue: "Add conversation",
  });
  const addPostLabel = t("charactereditor.AddPost", {
    defaultValue: "Add Post",
  });

  const addConversation = () => {
    const agentName =
      typeof d.name === "string" && d.name.trim() ? d.name.trim() : "Agent";
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
  };
  const addPost = () => {
    handleFieldEdit("postExamples", [...postExamples, ""]);
  };

  const { ref: addConversationRef, agentProps: addConversationAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "example-add-conversation",
      role: "button",
      label: addConversationLabel,
      group: "chat-examples",
      description: "Add a new chat-example conversation",
      onActivate: addConversation,
    });
  const { ref: addPostRef, agentProps: addPostAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "post-example-add",
      role: "button",
      label: addPostLabel,
      group: "post-examples",
      description: "Add a new post example",
      onActivate: addPost,
    });

  return (
    <div className="flex flex-col gap-6">
      {/* Chat Examples — flat, no card/border; whitespace separates conversations. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span className="text-xs font-medium text-muted">
            {t("charactereditor.ChatExamples", {
              defaultValue: "Chat Examples",
            })}
          </span>
          <span className="text-xs text-muted">
            {normalizedMessageExamples.length}{" "}
            {t("charactereditor.ConversationCount", {
              defaultValue: "conversations",
            })}
          </span>
        </div>
        <div className="flex flex-col gap-6">
          {normalizedMessageExamples.map((convo, ci) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
              key={`convo-${ci}`}
              className="group/convo flex flex-col gap-2"
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
                  <ConversationTurnTextarea
                    ci={ci}
                    mi={mi}
                    isUser={msg.name === "{{user1}}"}
                    value={msg.content?.text ?? ""}
                    onChange={(text) => {
                      const updated = [...normalizedMessageExamples];
                      const convoClone = {
                        examples: [...updated[ci].examples],
                      };
                      convoClone.examples[mi] = {
                        ...convoClone.examples[mi],
                        content: { text },
                      };
                      updated[ci] = convoClone;
                      handleFieldEdit("messageExamples", updated);
                    }}
                  />
                </div>
              ))}
              <ConversationFooter
                ci={ci}
                onAddTurn={() => {
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
                onRemove={() => {
                  const updated = [...normalizedMessageExamples];
                  updated.splice(ci, 1);
                  handleFieldEdit("messageExamples", updated);
                }}
                t={t}
              />
            </div>
          ))}
          {normalizedMessageExamples.length === 0 && (
            <div className="py-4 text-sm text-muted">
              {t("charactereditor.NoChatExamples", {
                defaultValue: "No chat examples yet.",
              })}
            </div>
          )}
        </div>
        <Button
          ref={addConversationRef}
          variant="ghost"
          size="sm"
          className="inline-flex h-9 self-start items-center gap-2 rounded-sm px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10"
          onClick={addConversation}
          title={addConversationLabel}
          aria-label={addConversationLabel}
          {...addConversationAgentProps}
        >
          <PlusIconSvg />
          {addConversationLabel}
        </Button>
      </section>

      {/* Post Examples — flat, no card/border; whitespace separates posts. */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span className="text-xs font-medium text-muted">
            {t("charactereditor.PostExamples", {
              defaultValue: "Post Examples",
            })}
          </span>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>
              {postExamples.length}{" "}
              {t("charactereditor.PostCount", {
                defaultValue: "posts",
              })}
            </span>
            {duplicatePostIndices.size > 0 ? (
              <span className="text-warning">
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
              <PostExampleRow
                // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
                key={`post-${pi}`}
                pi={pi}
                post={post}
                isDuplicate={isDuplicate}
                isDragging={isDragging}
                onDragStart={(e) => {
                  setDragPostIndex(pi);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  handleFieldEdit(
                    "postExamples",
                    reorder(postExamples, dragPostIndex, pi),
                  );
                  setDragPostIndex(null);
                }}
                onDragEnd={() => setDragPostIndex(null)}
                onChange={(value) => {
                  const updated = [...postExamples];
                  updated[pi] = value;
                  handleFieldEdit("postExamples", updated);
                }}
                onRemove={() => {
                  const updated = [...postExamples];
                  updated.splice(pi, 1);
                  handleFieldEdit("postExamples", updated);
                }}
                t={t}
              />
            );
          })}
          {postExamples.length === 0 && (
            <div className="py-4 text-sm text-muted">
              {t("charactereditor.NoPostExamples", {
                defaultValue: "No post examples yet.",
              })}
            </div>
          )}
          <Button
            ref={addPostRef}
            variant="ghost"
            size="sm"
            className="mt-1 inline-flex h-9 self-start items-center gap-2 rounded-sm px-3 text-sm font-medium text-accent transition-colors hover:bg-accent/10"
            onClick={addPost}
            title={addPostLabel}
            aria-label={addPostLabel}
            {...addPostAgentProps}
          >
            <PlusIconSvg />
            {addPostLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

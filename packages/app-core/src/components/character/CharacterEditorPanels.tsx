import type { MessageExampleGroup } from "@elizaos/core";
import { Button, Input, Textarea, ThemedSelect } from "@elizaos/ui";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useState,
} from "react";
import type { CharacterData } from "../../api/client-types-config";
import { EDGE_BACKUP_VOICES, PREMADE_VOICES } from "../../voice/types";

/* ── Inline SVG icon helpers ─────────────────────────────────────── */
const svgBase = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const Volume2 = ({ className }: { className?: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);
const VolumeX = ({ className }: { className?: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
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

/* ── Small duplicate/copy icon ───────────────────────────────────── */
const CopyIconSvg = ({ className }: { className?: string }) => (
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
    <rect x="3.25" y="3.25" width="6.5" height="6.5" rx="1" />
    <path d="M7.5 3.25V2.25a1 1 0 0 0-1-1h-3.5a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1h1" />
  </svg>
);

/* ── Shared styles for inline plus/trash buttons ─────────────────── */
const inlineAddBtn =
  "inline-flex items-center gap-1 text-3xs font-semibold text-accent/80 hover:text-accent hover:bg-accent/10 rounded px-1.5 py-1 -mx-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";
const inlineRemoveBtn =
  "inline-flex items-center text-muted hover:text-danger hover:bg-danger/10 rounded p-1 -m-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50";

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

/* ── Types ────────────────────────────────────────────────────────── */

export interface CharacterIdentityPanelProps {
  d: CharacterData;
  bioText: string;
  generating: string | null;
  voiceSelectValue: string | null;
  activeVoicePreset: (typeof PREMADE_VOICES)[number] | null;
  voiceTesting: boolean;
  voiceLoading: boolean;
  useElevenLabs: boolean;
  elevenLabsVoiceGroups: {
    label: string;
    items: { id: string; text: string }[];
  }[];
  edgeVoiceGroups: { label: string; items: { id: string; text: string }[] }[];
  handleFieldEdit: (field: string, value: unknown) => void;
  handleGenerate: (field: string, mode?: "replace" | "append") => Promise<void>;
  handleSelectPreset: (
    preset: (typeof PREMADE_VOICES)[0] | (typeof EDGE_BACKUP_VOICES)[0],
  ) => void;
  handleStopTest: () => void;
  setVoiceTesting: (v: boolean) => void;
  setVoiceTestAudio: (v: HTMLAudioElement | null) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

export interface CharacterStylePanelProps {
  d: CharacterData;
  generating: string | null;
  pendingStyleEntries: Record<string, string>;
  styleEntryDrafts: Record<string, string[]>;
  handleGenerate: (field: string, mode?: "replace" | "append") => Promise<void>;
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
  generating: string | null;
  handleFieldEdit: (field: string, value: unknown) => void;
  handleGenerate: (field: string, mode?: "replace" | "append") => Promise<void>;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

/* ── CharacterIdentityPanel ──────────────────────────────────────── */

export function CharacterIdentityPanel({
  d,
  bioText,
  generating,
  voiceSelectValue,
  activeVoicePreset,
  voiceTesting,
  voiceLoading,
  useElevenLabs,
  elevenLabsVoiceGroups,
  edgeVoiceGroups,
  handleFieldEdit,
  handleGenerate,
  handleSelectPreset,
  handleStopTest,
  setVoiceTesting,
  setVoiceTestAudio,
  t,
}: CharacterIdentityPanelProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
        <div className="flex flex-col gap-2 min-w-0">
          <span
            id="character-editor-name-label"
            className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
          >
            {t("charactereditor.Name", { defaultValue: "Name" })}
          </span>
          <Input
            type="text"
            value={d.name ?? ""}
            placeholder={t("charactereditor.AgentNamePlaceholder", {
              defaultValue: "Agent name",
            })}
            aria-labelledby="character-editor-name-label"
            onChange={(
              e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
            ) => handleFieldEdit("name", e.target.value)}
            className="h-9 rounded-none border-0 border-b border-border/40 bg-transparent px-0 text-sm text-txt focus-visible:border-accent/60 focus-visible:ring-0"
          />
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <span
            id="character-editor-voice-label"
            className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
          >
            {t("charactereditor.Voice", { defaultValue: "Voice" })}
          </span>
          <div className="flex items-center gap-1.5">
            <ThemedSelect
              value={voiceSelectValue}
              groups={useElevenLabs ? elevenLabsVoiceGroups : edgeVoiceGroups}
              onChange={(id: string) => {
                const allVoices = useElevenLabs
                  ? PREMADE_VOICES
                  : EDGE_BACKUP_VOICES;
                const preset = allVoices.find((p) => p.id === id);
                if (preset) handleSelectPreset(preset);
              }}
              placeholder={t("charactereditor.SelectAVoice", {
                defaultValue: "Select a voice",
              })}
              ariaLabelledBy="character-editor-voice-label"
              menuPlacement="bottom"
              className="flex-1 min-w-0"
              triggerClassName="h-9 rounded-none border-0 border-b border-border/40 bg-transparent px-0 text-sm shadow-none"
              menuClassName="border-border/60 bg-bg/92 shadow-2xl backdrop-blur-md"
            />
            <Button
              type="button"
              variant={voiceTesting ? "destructive" : "ghost"}
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full p-0 text-muted hover:text-txt"
              onClick={() => {
                if (voiceTesting) {
                  handleStopTest();
                } else if (activeVoicePreset?.previewUrl) {
                  setVoiceTesting(true);
                  const audio = new Audio(activeVoicePreset.previewUrl);
                  audio.onended = () => {
                    setVoiceTesting(false);
                    setVoiceTestAudio(null);
                  };
                  audio.onerror = () => {
                    setVoiceTesting(false);
                    setVoiceTestAudio(null);
                  };
                  setVoiceTestAudio(audio);
                  audio.play().catch(() => {
                    setVoiceTesting(false);
                    setVoiceTestAudio(null);
                  });
                }
              }}
              aria-label={voiceTesting ? "Stop voice preview" : "Preview voice"}
              disabled={!activeVoicePreset || voiceLoading}
            >
              {voiceTesting ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>

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
          className="w-full resize-y min-h-[8rem] rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-2 font-mono text-xs leading-relaxed text-txt focus-visible:border-accent/60 focus-visible:ring-0"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          {t("charactereditor.SystemPrompt", {
            defaultValue: "Things I Should Always Remember",
          })}
        </span>
        <Textarea
          value={d.system ?? ""}
          rows={8}
          maxLength={100000}
          placeholder={t("charactereditor.SystemPromptPlaceholder", {
            defaultValue: "Write in first person...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("system", e.target.value)
          }
          className="w-full resize-y min-h-[8rem] rounded-none border-0 border-b border-border/40 bg-transparent px-0 py-2 font-mono text-xs leading-relaxed text-txt focus-visible:border-accent/60 focus-visible:ring-0"
        />
      </div>
    </div>
  );
}

/* ── CharacterStylePanel ─────────────────────────────────────────── */

export function CharacterStylePanel({
  d,
  generating,
  pendingStyleEntries,
  styleEntryDrafts,
  handleGenerate,
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
    <section className="flex flex-col gap-3">
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
        {t("charactereditor.StyleRulesHeader", {
          defaultValue: "Style Rules",
        })}
      </span>
      <div className="flex flex-col gap-3 min-h-0">
        {STYLE_SECTION_KEYS.map((key) => {
          const items = style?.[key] ?? [];
          return (
            <div
              key={key}
              className="flex flex-col gap-1.5"
              data-testid={`style-section-${key}`}
            >
              <div className="flex flex-col gap-1">
                {items.length > 0 ? (
                  items.map((item, index) => {
                    const isDragging =
                      dragStyleIndex?.key === key &&
                      dragStyleIndex.index === index;
                    return (
                    <div
                      key={`${key}:${item}`}
                      draggable
                      onDragStart={(e: DragEvent<HTMLDivElement>) => {
                        setDragStyleIndex({ key, index });
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e: DragEvent<HTMLDivElement>) => {
                        if (
                          dragStyleIndex === null ||
                          dragStyleIndex.key !== key ||
                          dragStyleIndex.index === index
                        )
                          return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e: DragEvent<HTMLDivElement>) => {
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
                      className={`group flex items-start gap-2 transition-opacity ${isDragging ? "opacity-40" : ""}`}
                    >
                      <span
                        className="mt-1 shrink-0 text-muted opacity-30 transition-opacity group-hover:opacity-80 cursor-grab active:cursor-grabbing select-none"
                        aria-hidden="true"
                        title={t("charactereditor.DragToReorder", {
                          defaultValue: "Drag to reorder",
                        })}
                      >
                        <GripIconSvg />
                      </span>
                      <span className="mt-0.5 shrink-0 text-2xs font-bold text-accent">
                        {index + 1}
                      </span>
                      <Textarea
                        value={styleEntryDrafts[key]?.[index] ?? item}
                        rows={1}
                        onChange={(
                          e: ChangeEvent<
                            HTMLInputElement | HTMLTextAreaElement
                          >,
                        ) =>
                          handleStyleEntryDraftChange(
                            key,
                            index,
                            e.target.value,
                          )
                        }
                        onBlur={() => handleCommitStyleEntry(key, index)}
                        aria-label={`${t(`charactereditor.StyleRules.${key}`, {
                          defaultValue: "Style rule",
                        })} ${index + 1}`}
                        className="min-w-0 flex-1 resize-none border-none bg-transparent p-0 font-mono text-xs leading-normal text-txt [field-sizing:content] min-h-[1.5em] focus-visible:outline-none focus-visible:shadow-none"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mt-0.5 h-auto w-auto shrink-0 p-0 text-muted opacity-0 transition-[opacity,color] duration-150 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
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
                    </div>
                    );
                  })
                ) : (
                  <div className="rounded-md border border-dashed border-border/40 px-3 py-4 text-center text-xs-tight text-muted">
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
                  className="min-w-0 text-xs h-7 flex-1 rounded-md border border-border bg-white/[0.03] px-2 font-mono text-xs-tight text-txt outline-none focus:border-accent"
                />
                <button
                  type="button"
                  className={inlineAddBtn}
                  onClick={() => handleAddStyleEntry(key)}
                  disabled={!pendingStyleEntries[key].trim()}
                  title={t("charactereditor.AddStyleRule", {
                    defaultValue: "Add style rule",
                  })}
                >
                  <PlusIconSvg />
                  {t("charactereditor.AddInline", {
                    defaultValue: "add",
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
  generating,
  handleFieldEdit,
  handleGenerate,
  t,
}: CharacterExamplesPanelProps) {
  const [dragConvoIndex, setDragConvoIndex] = useState<number | null>(null);
  const [dragPostIndex, setDragPostIndex] = useState<number | null>(null);

  const reorder = <T,>(list: T[], from: number, to: number): T[] => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  return (
    <>
      {/* Chat Examples */}
      <section className="flex flex-col gap-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          {t("charactereditor.ChatExamples", {
            defaultValue: "Chat Examples",
          })}
        </span>
        <div className="flex flex-col divide-y divide-border/30">
          {normalizedMessageExamples.map((convo, ci) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
              key={`convo-${ci}`}
              className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0"
            >
              {convo.examples.map((msg, mi) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
                  key={`msg-${ci}-${mi}`}
                  className="flex items-center gap-3"
                >
                  <GripIconSvg />
                  <span
                    className={`w-12 shrink-0 pr-1 text-right text-[0.5rem] font-semibold uppercase tracking-[0.06em] ${msg.name === "{{user1}}" ? "text-muted" : "text-accent"}`}
                  >
                    {msg.name === "{{user1}}" ? "user" : "agent"}
                  </span>
                  <Input
                    value={msg.content?.text ?? ""}
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
                    className="h-7 flex-1 rounded-md border border-border/50 bg-white/[0.03] px-2.5 text-xs-tight leading-tight text-txt outline-none focus:border-accent"
                  />
                </div>
              ))}
              <div className="mt-0.5 ml-[4.25rem] flex items-center justify-between">
                <button
                  type="button"
                  className="text-3xs font-semibold text-accent/80 hover:text-accent transition-colors"
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
                >
                  +{" "}
                  {t("charactereditor.AddTurn", {
                    defaultValue: "turn",
                  })}
                </button>
                <button
                  type="button"
                  className="text-3xs font-semibold text-muted hover:text-danger transition-colors"
                  onClick={() => {
                    const updated = [...normalizedMessageExamples];
                    updated.splice(ci, 1);
                    handleFieldEdit("messageExamples", updated);
                  }}
                  aria-label={`${t("common.remove")} conversation ${ci + 1}`}
                >
                  {t("charactereditor.RemoveExample", {
                    defaultValue: "remove",
                  })}
                </button>
              </div>
            </div>
          ))}
          {normalizedMessageExamples.length === 0 && (
            <div className="rounded-md border border-dashed border-border/40 px-3 py-4 text-center text-xs-tight text-muted">
              {t("charactereditor.NoChatExamples", {
                defaultValue: "No chat examples yet.",
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`${inlineAddBtn} self-start mt-1`}
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
        >
          <PlusIconSvg />
          {t("charactereditor.ConversationLabel", {
            defaultValue: "conversation",
          })}
        </button>
      </section>

      {/* Post Examples */}
      <section className="flex flex-col gap-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          {t("charactereditor.PostExamples", {
            defaultValue: "Post Examples",
          })}
        </span>
        <div className="flex flex-col gap-1.5">
          {(d.postExamples ?? []).map((post, pi) => {
            const isDragging = dragPostIndex === pi;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
                key={`post-${pi}`}
                draggable
                onDragStart={(e: DragEvent<HTMLDivElement>) => {
                  setDragPostIndex(pi);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e: DragEvent<HTMLDivElement>) => {
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e: DragEvent<HTMLDivElement>) => {
                  e.preventDefault();
                  if (dragPostIndex === null || dragPostIndex === pi) return;
                  handleFieldEdit(
                    "postExamples",
                    reorder(d.postExamples ?? [], dragPostIndex, pi),
                  );
                  setDragPostIndex(null);
                }}
                onDragEnd={() => setDragPostIndex(null)}
                className={`group flex items-center gap-1.5 transition-opacity ${isDragging ? "opacity-40" : ""}`}
              >
                <span
                  className="text-muted opacity-30 transition-opacity group-hover:opacity-80 cursor-grab active:cursor-grabbing select-none"
                  aria-hidden="true"
                  title={t("charactereditor.DragToReorder", {
                    defaultValue: "Drag to reorder",
                  })}
                >
                  <GripIconSvg />
                </span>
                <Input
                  value={post}
                  aria-label={`Post example ${pi + 1}`}
                  onChange={(e) => {
                    const updated = [...(d.postExamples ?? [])];
                    updated[pi] = e.target.value;
                    handleFieldEdit("postExamples", updated);
                  }}
                  className="h-7 flex-1 rounded-md border border-border/50 bg-white/[0.03] px-2.5 text-xs-tight leading-tight text-txt outline-none focus:border-accent"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-auto w-auto shrink-0 p-0 text-muted opacity-0 transition-[opacity,color] duration-150 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => {
                    const updated = [...(d.postExamples ?? [])];
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
            );
          })}
          {(d.postExamples ?? []).length === 0 && (
            <div className="rounded-md border border-dashed border-border/40 px-3 py-4 text-center text-xs-tight text-muted">
              {t("charactereditor.NoPostExamples", {
                defaultValue: "No post examples yet.",
              })}
            </div>
          )}
          <button
            type="button"
            className={`${inlineAddBtn} self-start mt-1`}
            onClick={() => {
              const updated = [...(d.postExamples ?? []), ""];
              handleFieldEdit("postExamples", updated);
            }}
            title={t("charactereditor.AddPost", {
              defaultValue: "Add Post",
            })}
          >
            <PlusIconSvg />
            {t("charactereditor.PostLabel", {
              defaultValue: "post",
            })}
          </button>
        </div>
      </section>
    </>
  );
}

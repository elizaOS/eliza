import type { MessageExampleGroup } from "@elizaos/core";
import { Button, Input, Textarea, ThemedSelect } from "@elizaos/ui";
import type { ChangeEvent, KeyboardEvent } from "react";
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
const SparklesIcon = ({ className }: { className?: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <path d="M12 2l1.7 5.1L19 9l-5.3 1.9L12 16l-1.7-5.1L5 9l5.3-1.9L12 2z" />
    <path d="M19 13l.9 2.7L22 16l-2.1.3L19 19l-.9-2.7L16 16l2.1-.3L19 13z" />
  </svg>
);

/* ── Inline close icon used by multiple panels ───────────────────── */
const CloseIconSvg = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2 2l6 6M8 2l-6 6" />
  </svg>
);

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
    <div className="flex flex-1 min-h-0 flex-col gap-5">
      {/* Name + Voice (50/50 split) */}
      <section className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center justify-between">
              <span
                id="character-editor-name-label"
                className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
              >
                {t("charactereditor.Name", { defaultValue: "Name" })}
              </span>
            </div>
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
              className="h-8 rounded-lg border-border bg-white/[0.04] text-sm text-txt"
            />
          </div>
          <div className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center justify-between">
              <span
                id="character-editor-voice-label"
                className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
              >
                {t("charactereditor.Voice", {
                  defaultValue: "Voice",
                })}
              </span>
            </div>
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
                triggerClassName="h-8 rounded-md border-border/50 bg-bg/65 px-3 py-0 text-xs-tight shadow-inner backdrop-blur-sm"
                menuClassName="border-border/60 bg-bg/92 shadow-2xl backdrop-blur-md"
              />
              <Button
                type="button"
                variant={voiceTesting ? "destructive" : "outline"}
                size="icon"
                className="h-8 w-8 rounded-full border-transparent bg-transparent p-0 shadow-none text-muted shrink-0 hover:text-txt hover:bg-white/10"
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
                aria-label={
                  voiceTesting ? "Stop voice preview" : "Preview voice"
                }
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
      </section>

      {/* Bio / About Me */}
      <section className="flex flex-1 min-h-[15rem] flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("charactereditor.AboutMe", {
              defaultValue: "About Me",
            })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full p-0 text-accent"
            onClick={() => void handleGenerate("bio")}
            disabled={generating === "bio"}
            title={t("charactereditor.Regenerate", {
              defaultValue: "Regenerate",
            })}
            aria-label={t("charactereditor.Regenerate", {
              defaultValue: "Regenerate",
            })}
          >
            {generating === "bio" ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <SparklesIcon className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <Textarea
          value={bioText}
          rows={6}
          placeholder={t("charactereditor.AboutMePlaceholder", {
            defaultValue: "Describe who your agent is...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("bio", e.target.value)
          }
          className="flex-1 min-h-12 resize-none overflow-y-auto rounded-lg border-border bg-white/[0.04] px-3 py-2 font-mono text-xs leading-relaxed text-txt h-full min-h-[14rem] max-h-none"
        />
      </section>

      {/* System Prompt / Directions */}
      <section className="flex flex-1 min-h-[15rem] flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("charactereditor.SystemPrompt", {
              defaultValue: "Things I Should Always Remember",
            })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full p-0 text-accent"
            onClick={() => void handleGenerate("system")}
            disabled={generating === "system"}
            title={t("charactereditor.Regenerate", {
              defaultValue: "Regenerate",
            })}
            aria-label={t("charactereditor.Regenerate", {
              defaultValue: "Regenerate",
            })}
          >
            {generating === "system" ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <SparklesIcon className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <Textarea
          value={d.system ?? ""}
          rows={6}
          maxLength={10000}
          placeholder={t("charactereditor.SystemPromptPlaceholder", {
            defaultValue: "Write in first person...",
          })}
          onChange={(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            handleFieldEdit("system", e.target.value)
          }
          className="flex-1 min-h-12 resize-none overflow-y-auto rounded-lg border-border bg-white/[0.04] px-3 py-2 font-mono text-xs leading-relaxed text-txt h-full min-h-[14rem] max-h-none"
        />
      </section>
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
  t,
}: CharacterStylePanelProps) {
  const style = d.style;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-full p-0 text-accent"
          onClick={() => void handleGenerate("style", "replace")}
          disabled={generating === "style"}
          title={t("charactereditor.Regenerate", {
            defaultValue: "Regenerate",
          })}
          aria-label={t("charactereditor.Regenerate", {
            defaultValue: "Regenerate",
          })}
        >
          {generating === "style" ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <SparklesIcon className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
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
                  items.map((item, index) => (
                    <div
                      key={`${key}:${item}`}
                      className="group flex items-start gap-2"
                    >
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
                        className="mt-0.5 h-auto w-auto shrink-0 p-0 text-muted opacity-0 transition-[opacity,color,box-shadow] duration-150 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger/40"
                        onClick={() => handleRemoveStyleEntry(key, index)}
                        title={t("common.remove")}
                        aria-label={`${t("common.remove")} ${t(
                          `charactereditor.StyleRules.${key}`,
                          {
                            defaultValue: "style rule",
                          },
                        )} ${index + 1}`}
                      >
                        <CloseIconSvg />
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="px-0 py-1 text-xs-tight text-muted">
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
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs font-bold text-accent"
                  onClick={() => handleAddStyleEntry(key)}
                  disabled={!pendingStyleEntries[key].trim()}
                >
                  {t("charactereditor.AddInline", {
                    defaultValue: "+ add",
                  })}
                </Button>
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
  return (
    <>
      {/* Chat Examples */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("charactereditor.ChatExamples", {
              defaultValue: "Chat Examples",
            })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full p-0 text-accent"
            onClick={() => void handleGenerate("chatExamples", "replace")}
            disabled={generating === "chatExamples"}
            title={t("charactereditor.Generate", {
              defaultValue: "Generate",
            })}
            aria-label={t("charactereditor.Generate", {
              defaultValue: "Generate",
            })}
          >
            {generating === "chatExamples" ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <SparklesIcon className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
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
                  <span
                    className={`w-14 shrink-0 pr-1 text-right text-[0.5rem] font-semibold uppercase tracking-[0.06em] ${msg.name === "{{user1}}" ? "text-muted" : "text-accent"}`}
                  >
                    {msg.name === "{{user1}}" ? "user" : "agent"}
                  </span>
                  <Input
                    value={msg.content?.text ?? ""}
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
            <div className="px-0 py-1 text-xs-tight text-muted">
              {t("charactereditor.NoChatExamples", {
                defaultValue: "No chat examples yet.",
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          className="self-start mt-1 text-3xs font-semibold text-accent/80 hover:text-accent transition-colors"
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
        >
          +{" "}
          {t("charactereditor.AddConversation", {
            defaultValue: "Add conversation",
          })}
        </button>
      </section>

      {/* Post Examples */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("charactereditor.PostExamples", {
              defaultValue: "Post Examples",
            })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full p-0 text-accent"
            onClick={() => void handleGenerate("postExamples", "replace")}
            disabled={generating === "postExamples"}
            title={t("charactereditor.Generate", {
              defaultValue: "Generate",
            })}
            aria-label={t("charactereditor.Generate", {
              defaultValue: "Generate",
            })}
          >
            {generating === "postExamples" ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <SparklesIcon className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {(d.postExamples ?? []).map((post, pi) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: items lack stable keys
              key={`post-${pi}`}
              className="group flex items-center gap-1.5"
            >
              <Input
                value={post}
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
                className="mt-0.5 h-auto w-auto shrink-0 p-0 text-muted opacity-0 transition-[opacity,color,box-shadow] duration-150 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger/40"
                onClick={() => {
                  const updated = [...(d.postExamples ?? [])];
                  updated.splice(pi, 1);
                  handleFieldEdit("postExamples", updated);
                }}
              >
                <CloseIconSvg />
              </Button>
            </div>
          ))}
          {(d.postExamples ?? []).length === 0 && (
            <div className="px-0 py-1 text-xs-tight text-muted">
              {t("charactereditor.NoPostExamples", {
                defaultValue: "No post examples yet.",
              })}
            </div>
          )}
          <button
            type="button"
            className="self-start mt-1 text-3xs font-semibold text-accent/80 hover:text-accent transition-colors"
            onClick={() => {
              const updated = [...(d.postExamples ?? []), ""];
              handleFieldEdit("postExamples", updated);
            }}
          >
            +{" "}
            {t("charactereditor.AddPost", {
              defaultValue: "Add Post",
            })}
          </button>
        </div>
      </section>
    </>
  );
}

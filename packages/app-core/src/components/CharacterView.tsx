/**
 * Character view — roster-first character selection with optional customization.
 */

import {
  type CharacterData,
  client,
  type StylePreset,
  type VoiceConfig,
} from "@elizaos/app-core/api";
import {
  dispatchWindowEvent,
  VOICE_CONFIG_UPDATED_EVENT,
} from "@elizaos/app-core/events";
import { COMPANION_ENABLED } from "@elizaos/app-core/navigation";
import { normalizeGeneratedMessageExamples } from "../actions/character";
import { useApp } from "@elizaos/app-core/state";
import {
  CharacterRoster,
  type CharacterRosterEntry,
  resolveRosterEntries,
} from "./CharacterRoster";
import {
  PREMADE_VOICES,
  sanitizeApiKey,
  type VoicePreset,
} from "@elizaos/app-core/voice";
import { Button, Input, Textarea, ThemedSelect } from "@elizaos/ui";
import { Lock, LockOpen, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_ELEVEN_FAST_MODEL = "eleven_flash_v2_5";

type StyleSectionKey = "all" | "chat" | "post";
type CustomizeStep = "core" | "style" | "examples";
const STYLE_SECTION_KEYS: StyleSectionKey[] = ["all", "chat", "post"];
const getStyleSectionPlaceholders = (t: any): Record<StyleSectionKey, string> => ({
  all: t("characterview.addSharedRule"),
  chat: t("characterview.addChatRule"),
  post: t("characterview.addPostRule"),
});
const getStyleSectionEmptyStates = (t: any): Record<StyleSectionKey, string> => ({
  all: t("characterview.noSharedRules"),
  chat: t("characterview.noChatRules"),
  post: t("characterview.noPostRules"),
});
const getVoiceSelectGroups = (t: any) => [
  {
    label: t("characterview.voiceGroupFemale"),
    items: PREMADE_VOICES.filter((preset) => preset.gender === "female").map(
      (preset) => ({
        id: preset.id,
        text: preset.name,
      }),
    ),
  },
  {
    label: t("characterview.voiceGroupMale"),
    items: PREMADE_VOICES.filter((preset) => preset.gender === "male").map(
      (preset) => ({
        id: preset.id,
        text: preset.name,
      }),
    ),
  },
  {
    label: t("characterview.voiceGroupCharacter"),
    items: PREMADE_VOICES.filter((preset) => preset.gender === "character").map(
      (preset) => ({
        id: preset.id,
        text: preset.name,
      }),
    ),
  },
];

function replaceCharacterToken(value: string, name: string) {
  return value.replaceAll("{{name}}", name).replaceAll("{{agentName}}", name);
}

function buildCharacterFromPreset(
  preset: StylePreset,
  name: string,
): CharacterData {
  return {
    name,
    username: name,
    bio: preset.bio.map((line) => replaceCharacterToken(line, name)),
    system: replaceCharacterToken(preset.system, name),
    adjectives: [...preset.adjectives],
    style: {
      all: [...preset.style.all],
      chat: [...preset.style.chat],
      post: [...preset.style.post],
    },
    messageExamples: preset.messageExamples.map((conversation) => ({
      examples: conversation.map((message) => ({
        name:
          message.user === "{{agentName}}"
            ? name
            : replaceCharacterToken(message.user, name),
        content: {
          text: replaceCharacterToken(message.content.text, name),
        },
      })),
    })),
    postExamples: preset.postExamples.map((example) =>
      replaceCharacterToken(example, name),
    ),
  };
}

function buildCharacterDraftFromPreset(
  entry: CharacterRosterEntry,
): CharacterData {
  const character = buildCharacterFromPreset(entry.preset, entry.name);
  return {
    name: character.name ?? "",
    username: character.username ?? "",
    bio: Array.isArray(character.bio)
      ? character.bio.join("\n")
      : (character.bio ?? ""),
    system: character.system ?? "",
    adjectives: character.adjectives ?? [],
    style: {
      all: character.style?.all ?? [],
      chat: character.style?.chat ?? [],
      post: character.style?.post ?? [],
    },
    messageExamples: character.messageExamples ?? [],
    postExamples: character.postExamples ?? [],
  };
}

function normalizeCharacterDraftForComparison(
  character: CharacterData | null | undefined,
) {
  return {
    name: (character?.name ?? "").trim(),
    username: (character?.username ?? "").trim(),
    bio:
      typeof character?.bio === "string"
        ? character.bio.trim()
        : Array.isArray(character?.bio)
          ? character.bio.join("\n").trim()
          : "",
    system: (character?.system ?? "").trim(),
    adjectives: [...(character?.adjectives ?? [])],
    style: {
      all: [...(character?.style?.all ?? [])],
      chat: [...(character?.style?.chat ?? [])],
      post: [...(character?.style?.post ?? [])],
    },
    messageExamples: (character?.messageExamples ?? []).map((conversation) => ({
      examples: (conversation.examples ?? []).map((message) => ({
        name: message.name,
        content: {
          text: message.content?.text ?? "",
        },
      })),
    })),
    postExamples: [...(character?.postExamples ?? [])],
  };
}

function characterDraftMatchesPreset(
  character: CharacterData | null | undefined,
  avatarIndex: number,
  entry: CharacterRosterEntry,
) {
  if (avatarIndex !== entry.avatarIndex) return false;
  const normalizedCurrent = normalizeCharacterDraftForComparison(character);
  const normalizedPreset = normalizeCharacterDraftForComparison(
    buildCharacterDraftFromPreset(entry),
  );
  return JSON.stringify(normalizedCurrent) === JSON.stringify(normalizedPreset);
}


function findMatchingRosterEntry(
  character: CharacterData | null,
  avatarIndex: number,
  roster: CharacterRosterEntry[],
) {
  if (!character) return null;
  const currentName =
    typeof character.name === "string" ? character.name.trim() : "";
  const exactNameMatch = roster.find((entry) => entry.name === currentName);
  if (exactNameMatch) return exactNameMatch.id;

  let bestMatch: { id: string; score: number } | null = null;
  for (const entry of roster) {
    let score = 0;
    if (entry.avatarIndex === avatarIndex) score += 3;

    const draftAdjectives = new Set(character.adjectives ?? []);
    for (const adjective of entry.preset.adjectives) {
      if (draftAdjectives.has(adjective)) score += 1;
    }

    if (
      typeof character.system === "string" &&
      character.system.includes(entry.preset.catchphrase)
    ) {
      score += 1;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { id: entry.id, score };
    }
  }

  return bestMatch && bestMatch.score >= 4 ? bestMatch.id : null;
}

function findExactRosterEntry(
  character: CharacterData | null,
  roster: CharacterRosterEntry[],
) {
  if (!character) return null;
  const currentName =
    typeof character.name === "string" ? character.name.trim() : "";
  return roster.find((entry) => entry.name === currentName) ?? null;
}

function hasCharacterContent(character: CharacterData | null | undefined) {
  return Boolean(character && Object.keys(character).length > 0);
}

function resolveActiveRosterEntry(
  character: CharacterData | null | undefined,
  avatarIndex: number,
  selectedCharacterId: string | null,
  roster: CharacterRosterEntry[],
) {
  if (selectedCharacterId) {
    const selectedEntry =
      roster.find((entry) => entry.id === selectedCharacterId) ?? null;
    if (selectedEntry) return selectedEntry;
  }

  const exactEntry = findExactRosterEntry(character ?? null, roster);
  if (exactEntry) return exactEntry;

  const matchedId = findMatchingRosterEntry(
    character ?? null,
    avatarIndex,
    roster,
  );
  if (!matchedId) return null;
  return roster.find((entry) => entry.id === matchedId) ?? null;
}

function getStyleEntryRenderKey(
  section: StyleSectionKey,
  items: string[],
  item: string,
  index: number,
) {
  let occurrence = 0;
  for (const current of items.slice(0, index + 1)) {
    if (current === item) occurrence += 1;
  }
  return `${section}:${item}:${occurrence}`;
}

/* ── CharacterView ──────────────────────────────────────────────────── */

export function CharacterView({
  inModal,
  sceneOverlay = false,
}: {
  inModal?: boolean;
  sceneOverlay?: boolean;
} = {}) {
  const {
    tab,
    setTab,
    characterData,
    characterDraft,
    characterLoading,
    characterSaving,
    characterSaveSuccess,
    characterSaveError,
    handleCharacterFieldInput,
    handleCharacterArrayInput,
    handleCharacterStyleInput,
    handleSaveCharacter,
    loadCharacter,
    setState,
    onboardingOptions,
    selectedVrmIndex,
    t,
    // Registry / Drop
    registryStatus,
    registryLoading,
    registryRegistering,
    registryError,
    dropStatus,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    walletConfig,
  } = useApp();

  useEffect(() => {
    void loadCharacter();
    void loadRegistryStatus();
    void loadDropStatus();
  }, [loadCharacter, loadRegistryStatus, loadDropStatus]);

  const handleFieldEdit = useCallback(
    <K extends keyof CharacterData>(field: K, value: CharacterData[K]) => {
      handleCharacterFieldInput(field, value);
    },
    [handleCharacterFieldInput],
  );

  const handleStyleEdit = useCallback(
    (key: "all" | "chat" | "post", value: string) => {
      handleCharacterStyleInput(key, value);
    },
    [handleCharacterStyleInput],
  );

  /* ── Character generation state ─────────────────────────────────── */
  const [generating, setGenerating] = useState<string | null>(null);
  const [pendingStyleEntries, setPendingStyleEntries] = useState<
    Record<StyleSectionKey, string>
  >({
    all: "",
    chat: "",
    post: "",
  });
  const [styleEntryDrafts, setStyleEntryDrafts] = useState<
    Record<StyleSectionKey, string[]>
  >({
    all: [],
    chat: [],
    post: [],
  });
  const [customizeStep, setCustomizeStep] = useState<CustomizeStep>("core");
  const [customOverridesEnabled, setCustomOverridesEnabled] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(
    null,
  );
  const [rosterStyles, setRosterStyles] = useState<StylePreset[]>(
    onboardingOptions?.styles ?? [],
  );

  /* ── Voice config state ─────────────────────────────────────────── */
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({});
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceSaveError, setVoiceSaveError] = useState<string | null>(null);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const [voiceTestAudio, setVoiceTestAudio] = useState<HTMLAudioElement | null>(
    null,
  );
  const [selectedVoicePresetId, setSelectedVoicePresetId] = useState<
    string | null
  >(null);
  const [voiceSelectionLocked, setVoiceSelectionLocked] = useState(false);

  useEffect(() => {
    if (onboardingOptions?.styles?.length) {
      setRosterStyles(onboardingOptions.styles);
      return;
    }

    let cancelled = false;
    void client
      .getOnboardingOptions()
      .then((options) => {
        if (!cancelled) {
          setRosterStyles(options.styles ?? []);
        }
      })
      .catch(() => {
        /* ignore */
      });

    return () => {
      cancelled = true;
    };
  }, [onboardingOptions?.styles]);

  const characterRoster = resolveRosterEntries(rosterStyles);
  const visibleCharacterRoster = characterRoster;
  const currentCharacter = hasCharacterContent(characterDraft)
    ? characterDraft
    : characterData;
  const activeRosterEntry = resolveActiveRosterEntry(
    currentCharacter,
    selectedVrmIndex,
    selectedCharacterId,
    characterRoster,
  );
  const detailedEditMode = tab === "character";

  /* Load voice config on mount */
  useEffect(() => {
    void (async () => {
      setVoiceLoading(true);
      try {
        const cfg = await client.getConfig();
        const messages = cfg.messages as
          | Record<string, Record<string, unknown>>
          | undefined;
        const tts = messages?.tts as VoiceConfig | undefined;
        if (tts) {
          setVoiceConfig(tts);
          if (tts.elevenlabs?.voiceId) {
            const preset = PREMADE_VOICES.find(
              (p) => p.voiceId === tts.elevenlabs?.voiceId,
            );
            setSelectedVoicePresetId(preset?.id ?? null);
          }
        }
      } catch {
        /* ignore */
      }
      setVoiceLoading(false);
    })();
  }, []);

  const handleSelectPreset = useCallback((preset: VoicePreset) => {
    setSelectedVoicePresetId(preset.id);
    setVoiceConfig((prev) => ({
      ...prev,
      elevenlabs: { ...(prev.elevenlabs ?? {}), voiceId: preset.voiceId },
    }));
  }, []);

  const applyVoicePresetForEntry = useCallback(
    (entry: CharacterRosterEntry) => {
      setVoiceSaveError(null);
      if (!entry.voicePresetId) return;
      const voicePreset = PREMADE_VOICES.find(
        (preset) => preset.id === entry.voicePresetId,
      );
      if (voicePreset) handleSelectPreset(voicePreset);
    },
    [handleSelectPreset],
  );

  const applyCharacterDefaults = useCallback(
    (entry: CharacterRosterEntry) => {
      const nextCharacter = buildCharacterDraftFromPreset(entry);
      handleFieldEdit("name", nextCharacter.name ?? "");
      handleFieldEdit("username", nextCharacter.username ?? "");
      handleFieldEdit("bio", nextCharacter.bio ?? "");
      handleFieldEdit("system", nextCharacter.system ?? "");
      handleFieldEdit("adjectives", nextCharacter.adjectives ?? []);
      handleFieldEdit(
        "style",
        nextCharacter.style ?? { all: [], chat: [], post: [] },
      );
      handleFieldEdit("messageExamples", nextCharacter.messageExamples ?? []);
      handleFieldEdit("postExamples", nextCharacter.postExamples ?? []);
    },
    [handleFieldEdit],
  );

  const commitCharacterSelection = useCallback(
    (entry: CharacterRosterEntry, applyDefaults: boolean) => {
      setSelectedCharacterId(entry.id);
      setState("selectedVrmIndex", entry.avatarIndex);
      if (!voiceSelectionLocked && selectedCharacterId !== entry.id) {
        applyVoicePresetForEntry(entry);
      }
      if (applyDefaults) {
        applyCharacterDefaults(entry);
      }
    },
    [
      applyCharacterDefaults,
      applyVoicePresetForEntry,
      selectedCharacterId,
      setState,
      voiceSelectionLocked,
    ],
  );

  const handleTestVoice = useCallback(
    (previewUrl: string) => {
      if (voiceTestAudio) {
        voiceTestAudio.pause();
        voiceTestAudio.currentTime = 0;
      }
      setVoiceTesting(true);
      const audio = new Audio(previewUrl);
      setVoiceTestAudio(audio);
      audio.onended = () => setVoiceTesting(false);
      audio.onerror = () => setVoiceTesting(false);
      audio.play().catch(() => setVoiceTesting(false));
    },
    [voiceTestAudio],
  );

  const handleStopTest = useCallback(() => {
    if (voiceTestAudio) {
      voiceTestAudio.pause();
      voiceTestAudio.currentTime = 0;
    }
    setVoiceTesting(false);
  }, [voiceTestAudio]);

  const persistVoiceConfig = useCallback(async () => {
    setVoiceSaveError(null);
    const normalizedElevenlabs = {
      ...voiceConfig.elevenlabs,
      modelId: voiceConfig.elevenlabs?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
    };
    const sanitizedKey = sanitizeApiKey(normalizedElevenlabs?.apiKey);
    if (sanitizedKey) normalizedElevenlabs.apiKey = sanitizedKey;
    else delete normalizedElevenlabs.apiKey;

    const normalizedVoiceConfig: VoiceConfig = {
      ...voiceConfig,
      provider: voiceConfig.provider ?? "elevenlabs",
      elevenlabs: normalizedElevenlabs,
    };

    await client.updateConfig({
      messages: {
        tts: normalizedVoiceConfig,
      },
    });
    dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, normalizedVoiceConfig);
  }, [voiceConfig]);

  const d = characterDraft ?? ({} as Record<string, unknown>);
  const bioText =
    typeof d.bio === "string"
      ? d.bio
      : Array.isArray(d.bio)
        ? (d.bio as string[]).join("\n")
        : "";

  const getCharContext = useCallback(
    () => ({
      name: d.name ?? "",
      system: d.system ?? "",
      bio: bioText,
      style: d.style ?? { all: [], chat: [], post: [] },
      postExamples: d.postExamples ?? [],
    }),
    [d, bioText],
  );

  useEffect(() => {
    setStyleEntryDrafts({
      all: [...(d.style?.all ?? [])],
      chat: [...(d.style?.chat ?? [])],
      post: [...(d.style?.post ?? [])],
    });
  }, [d.style]);

  const handleGenerate = useCallback(
    async (field: string, mode: "append" | "replace" = "replace") => {
      setGenerating(field);
      try {
        const { generated } = await client.generateCharacterField(
          field,
          getCharContext(),
          mode,
        );
        if (field === "bio") {
          handleFieldEdit("bio", generated.trim());
        } else if (field === "system") {
          handleFieldEdit("system", generated.trim());
        } else if (field === "style") {
          try {
            const parsed = JSON.parse(generated);
            if (mode === "append") {
              handleStyleEdit(
                "all",
                [...(d.style?.all ?? []), ...(parsed.all ?? [])].join("\n"),
              );
              handleStyleEdit(
                "chat",
                [...(d.style?.chat ?? []), ...(parsed.chat ?? [])].join("\n"),
              );
              handleStyleEdit(
                "post",
                [...(d.style?.post ?? []), ...(parsed.post ?? [])].join("\n"),
              );
            } else {
              if (parsed.all) handleStyleEdit("all", parsed.all.join("\n"));
              if (parsed.chat) handleStyleEdit("chat", parsed.chat.join("\n"));
              if (parsed.post) handleStyleEdit("post", parsed.post.join("\n"));
            }
          } catch {
            /* raw text fallback */
          }
        } else if (field === "chatExamples") {
          const formatted = normalizeGeneratedMessageExamples(
            generated,
            d.name?.trim() || "Agent",
          );
          if (formatted.length > 0) {
            setState("characterSaveError", null);
            handleFieldEdit("messageExamples", formatted);
          } else {
            setState(
              "characterSaveError",
              "Generated chat examples could not be parsed. Try again.",
            );
          }
        } else if (field === "postExamples") {
          try {
            const parsed = JSON.parse(generated);
            if (Array.isArray(parsed)) {
              if (mode === "append") {
                handleCharacterArrayInput(
                  "postExamples",
                  [...(d.postExamples ?? []), ...parsed].join("\n"),
                );
              } else {
                handleCharacterArrayInput("postExamples", parsed.join("\n"));
              }
            }
          } catch {
            /* raw text fallback */
          }
        }
      } catch (err) {
        if (field === "chatExamples") {
          setState(
            "characterSaveError",
            err instanceof Error
              ? t("characterview.errorChatExamplesGenerate", { message: err.message })
              : t("characterview.errorChatExamplesGenerateFallback"),
          );
        }
      }
      setGenerating(null);
    },
    [
      getCharContext,
      d,
      handleFieldEdit,
      handleStyleEdit,
      handleCharacterArrayInput,
      setState,
    ],
  );

  const handlePendingStyleEntryChange = useCallback(
    (key: StyleSectionKey, value: string) => {
      setPendingStyleEntries((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleAddStyleEntry = useCallback(
    (key: StyleSectionKey) => {
      const value = pendingStyleEntries[key].trim();
      if (!value) return;

      const nextItems = [...(d.style?.[key] ?? [])];
      if (!nextItems.includes(value)) {
        nextItems.push(value);
        handleStyleEdit(key, nextItems.join("\n"));
      }

      setPendingStyleEntries((prev) => ({ ...prev, [key]: "" }));
    },
    [d.style, handleStyleEdit, pendingStyleEntries],
  );

  const handleRemoveStyleEntry = useCallback(
    (key: StyleSectionKey, index: number) => {
      const nextItems = [...(d.style?.[key] ?? [])];
      nextItems.splice(index, 1);
      handleStyleEdit(key, nextItems.join("\n"));
    },
    [d.style, handleStyleEdit],
  );

  const handleStyleEntryDraftChange = useCallback(
    (key: StyleSectionKey, index: number, value: string) => {
      setStyleEntryDrafts((prev) => {
        const nextItems = [...(prev[key] ?? [])];
        nextItems[index] = value;
        return { ...prev, [key]: nextItems };
      });
    },
    [],
  );

  const handleCommitStyleEntry = useCallback(
    (key: StyleSectionKey, index: number) => {
      const nextValue = styleEntryDrafts[key]?.[index]?.trim() ?? "";
      const nextItems = [...(d.style?.[key] ?? [])];

      if (!nextValue) {
        nextItems.splice(index, 1);
      } else {
        nextItems[index] = nextValue;
      }

      handleStyleEdit(key, nextItems.join("\n"));
    },
    [d.style, handleStyleEdit, styleEntryDrafts],
  );

  const handleSelectCharacter = useCallback(
    (entry: CharacterRosterEntry) => {
      const shouldApplyDefaults =
        !customOverridesEnabled &&
        (!currentCharacter ||
          !activeRosterEntry ||
          characterDraftMatchesPreset(
            currentCharacter,
            selectedVrmIndex,
            activeRosterEntry,
          ));
      commitCharacterSelection(entry, shouldApplyDefaults);
    },
    [
      activeRosterEntry,
      commitCharacterSelection,
      currentCharacter,
      customOverridesEnabled,
      selectedVrmIndex,
    ],
  );

  const handleCustomOverridesChange = useCallback(
    (enabled: boolean) => {
      setTab(enabled ? "character" : "character-select");
      setCustomOverridesEnabled(enabled);
      setCustomizeStep("core");
      if (enabled) return;

      const activeEntry = resolveActiveRosterEntry(
        currentCharacter,
        selectedVrmIndex,
        selectedCharacterId,
        characterRoster,
      );
      if (activeEntry) {
        setSelectedCharacterId(activeEntry.id);
      }
    },
    [
      characterRoster,
      currentCharacter,
      selectedCharacterId,
      selectedVrmIndex,
      setTab,
    ],
  );

  useEffect(() => {
    setCustomOverridesEnabled(detailedEditMode);
    if (detailedEditMode) {
      setCustomizeStep("core");
    }
  }, [detailedEditMode]);

  useEffect(() => {
    if (
      characterLoading ||
      selectedCharacterId ||
      !characterRoster.length ||
      !currentCharacter
    ) {
      return;
    }

    const activeEntry =
      resolveActiveRosterEntry(
        currentCharacter,
        selectedVrmIndex,
        selectedCharacterId,
        characterRoster,
      ) ??
      characterRoster[0] ??
      null;
    if (!activeEntry) return;
    const matchesFactory = characterDraftMatchesPreset(
      currentCharacter,
      selectedVrmIndex,
      activeEntry,
    );
    setSelectedCharacterId(activeEntry.id);
    setCustomOverridesEnabled(detailedEditMode);
    if (matchesFactory) {
      commitCharacterSelection(activeEntry, true);
    }
  }, [
    characterLoading,
    characterRoster,
    commitCharacterSelection,
    currentCharacter,
    detailedEditMode,
    selectedCharacterId,
    selectedVrmIndex,
  ]);

  const handleSaveAll = useCallback(async () => {
    const trimmedName =
      typeof characterDraft?.name === "string" ? characterDraft.name.trim() : "";
    if (!trimmedName) {
      setVoiceSaveError(null);
      setState("characterSaveSuccess", null);
      setState("characterSaveError", t("characterview.errorNameRequired"));
      return;
    }

    setVoiceSaveError(null);
    try {
      await handleSaveCharacter();
    } catch {
      return;
    }

    setVoiceSaving(true);
    let voiceSaveFailed = false;
    try {
      await persistVoiceConfig();
    } catch (err) {
      voiceSaveFailed = true;
      setVoiceSaveError(
        err instanceof Error ? err.message : t("characterview.errorVoiceSaveFailed"),
      );
    } finally {
      setVoiceSaving(false);
    }
    if (!voiceSaveFailed) {
      setTab(COMPANION_ENABLED ? "companion" : "chat");
    }
  }, [
    characterDraft?.name,
    handleSaveCharacter,
    persistVoiceConfig,
    setState,
    setTab,
  ]);

  /* ── Helpers ────────────────────────────────────────────────────── */
  const cardCls = sceneOverlay
    ? "p-5 border border-white/10 bg-black/15 backdrop-blur-md rounded-2xl shadow-[0_18px_48px_rgba(0,0,0,0.28)]"
    : "p-5 border border-border/40 bg-card/40 backdrop-blur-xl rounded-2xl shadow-sm";
  const editorCardCls = `${cardCls} flex min-h-0 flex-col overflow-hidden`;
  const sectionCls =
    sceneOverlay && !inModal ? "relative z-10 mt-4 px-1" : `mt-4 ${cardCls}`;
  const labelCls = "font-medium text-xs text-muted mb-1 block";
  const hintCls = "text-[11px] text-muted";
  const scrollPaneCls =
    "min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable] custom-scrollbar";

  if (characterLoading && !characterData) {
    return (
      <div className={sectionCls}>
        <div className="text-center py-6 text-[var(--muted)] text-[13px]">
          {t("characterview.loadingCharacterDa")}
        </div>
      </div>
    );
  }

  const hasWallet = Boolean(walletConfig?.evmAddress);
  const isRegistered = registryStatus?.registered === true;
  const dropLive =
    dropStatus?.dropEnabled &&
    dropStatus?.publicMintOpen &&
    !dropStatus?.mintedOut;
  const userMinted = dropStatus?.userHasMinted === true;
  const activeVoicePreset =
    PREMADE_VOICES.find((preset) => preset.id === selectedVoicePresetId) ??
    null;
  const voiceSelectValue = selectedVoicePresetId ?? null;
  const combinedSaveError = voiceSaveError ?? characterSaveError;
  const customizationActionLabel = customOverridesEnabled
    ? t("characterview.selectCharacter")
    : t("characterview.customize");
  const rootCls =
    sceneOverlay && !inModal
      ? "relative z-10 flex min-h-full flex-col justify-end pb-4"
      : `${inModal || sceneOverlay ? "pb-8" : ""} ${sceneOverlay ? "relative z-10" : ""
      }`;
  const coreFieldsPanel = (
    <div
      className={`${editorCardCls} max-h-[calc(100vh-14rem)] overflow-y-auto`}
      data-testid="character-core-editor"
    >
      <div className="mb-3 flex min-h-0 flex-col gap-1">
        <span className={labelCls}>{t("characterview.nameLabel")}</span>
        <Input
          type="text"
          value={d.name ?? ""}
          placeholder={t("characterview.characterNamePlaceholder")}
          onChange={(e) => handleFieldEdit("name", e.target.value)}
          className="h-10 rounded-lg border-border/50 bg-bg p-3 text-base font-bold focus-visible:border-accent focus-visible:ring-accent/50"
          data-testid="character-name-input"
        />
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={labelCls}>{t("characterview.aboutMeLabel") || "ABOUT ME"}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-md px-2 text-[10px] font-bold text-accent"
            onClick={() => void handleGenerate("bio")}
            disabled={generating === "bio"}
          >
            {generating === "bio" ? t("characterview.generating") : t("characterview.regenerate")}
          </Button>
        </div>
        <Textarea
          value={bioText}
          rows={6}
          placeholder={t("characterview.describeWhoYourAg")}
          onChange={(e) => handleFieldEdit("bio", e.target.value)}
          className="min-h-[10rem] flex-1 resize-none overflow-y-auto rounded-lg border-border/50 bg-bg p-3 text-sm leading-relaxed focus-visible:border-accent focus-visible:ring-accent/50"
        />
      </div>

      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className={labelCls}>
            {t("characterview.systemPromptLabel")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-md px-2 text-[10px] font-bold text-accent"
            onClick={() => void handleGenerate("system")}
            disabled={generating === "system"}
          >
            {generating === "system" ? t("characterview.generating") : t("characterview.regenerate")}
          </Button>
        </div>
        <Textarea
          value={d.system ?? ""}
          rows={7}
          maxLength={10000}
          placeholder={t("characterview.writeInFirstPerso")}
          onChange={(e) => handleFieldEdit("system", e.target.value)}
          className="min-h-[10rem] flex-1 resize-none overflow-y-auto rounded-lg border-border/50 bg-bg p-3 font-mono text-xs leading-relaxed focus-visible:border-accent focus-visible:ring-accent/50"
        />
      </div>
      {COMPANION_ENABLED && (
        <div className="mt-auto flex items-center justify-end pt-3 text-[11px] font-medium text-muted">
          {t("characterview.companionMode")}
        </div>
      )}
    </div>
  );
  const styleEditorPanel = (
    <div
      className={`${editorCardCls} max-h-[calc(100vh-14rem)] overflow-y-auto`}
      data-testid="character-customize-sidebar"
    >
      <div
        className="flex min-h-0 flex-col gap-3"
        data-testid="character-style-editor"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-bold tracking-wide text-txt">
            {t("characterview.StyleRules")}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 rounded-md px-2.5 text-[11px] font-bold"
            onClick={() => void handleGenerate("style", "replace")}
            disabled={generating === "style"}
          >
            {generating === "style" ? t("characterview.generating") : t("characterview.regenerate")}
          </Button>
        </div>

        <div
          className="grid min-h-0 flex-1 gap-3 xl:grid-cols-1 2xl:grid-cols-3"
          data-testid="character-style-editor-scroll"
        >
          {STYLE_SECTION_KEYS.map((key) => {
            const items = d.style?.[key] ?? [];
            return (
              <div
                key={key}
                className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/30 bg-bg/30"
                data-testid={`style-section-${key}`}
              >
                <div className="flex items-center justify-between gap-2 border-b border-border/20 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-muted">
                      {key}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted/70">
                      {items.length} {items.length === 1 ? t("characterview.rule") : t("characterview.rules")}
                    </span>
                  </div>
                </div>

                <div className={`${scrollPaneCls} flex-1 p-3 pr-2`}>
                  <div className="flex flex-col gap-2">
                    {items.length > 0 ? (
                      items.map((item, index) => (
                        <div
                          key={getStyleEntryRenderKey(key, items, item, index)}
                          className="group flex items-start gap-2 rounded-lg border border-border/20 bg-bg/30 px-3 py-2"
                          data-testid={`style-entry-${key}-${index}`}
                        >
                          <span className="mt-0.5 shrink-0 text-[10px] font-bold text-accent">
                            {index + 1}
                          </span>
                          <Textarea
                            value={styleEntryDrafts[key]?.[index] ?? item}
                            rows={1}
                            onChange={(e) =>
                              handleStyleEntryDraftChange(
                                key,
                                index,
                                e.target.value,
                              )
                            }
                            onBlur={() =>
                              handleCommitStyleEntry(key, index)
                            }
                            className="min-h-[2rem] min-w-0 flex-1 resize-none rounded border-0 bg-transparent p-0 text-sm leading-relaxed focus-visible:ring-0"
                            data-testid={`style-entry-editor-${key}-${index}`}
                          />
                          <button
                            type="button"
                            className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                            onClick={() =>
                              handleRemoveStyleEntry(key, index)
                            }
                            title={t("characterview.remove")}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    ) : (
                      <div
                        className={`${hintCls} rounded-lg border border-white/5 bg-black/5 py-3 text-center`}
                      >
                        {getStyleSectionEmptyStates(t)[key]}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 border-t border-border/20 px-3 py-2">
                  <Input
                    type="text"
                    value={pendingStyleEntries[key]}
                    placeholder={getStyleSectionPlaceholders(t)[key]}
                    onChange={(e) =>
                      handlePendingStyleEntryChange(key, e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddStyleEntry(key);
                      }
                    }}
                    className="h-8 min-w-0 flex-1 rounded-lg border-border/40 bg-bg/50 text-sm"
                    data-testid={`style-entry-input-${key}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 rounded-lg px-2.5 text-[11px] font-bold text-accent"
                    onClick={() => handleAddStyleEntry(key)}
                    disabled={!pendingStyleEntries[key].trim()}
                  >
                    {t("characterview.addStyleEntry")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
  const chatExamplesPanel = (
    <div
      className={`${editorCardCls} max-h-[calc(100vh-14rem)] overflow-y-auto`}
      data-testid="character-chat-examples-card"
    >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border/40 pb-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="text-sm font-bold tracking-wide text-txt">
            {t("characterview.chatExamples")}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 border-border/50 bg-bg/50 text-[11px] font-bold text-accent shadow-inner transition-all hover:border-accent/40 hover:text-accent"
          onClick={() => void handleGenerate("chatExamples", "replace")}
          disabled={generating === "chatExamples"}
        >
          {generating === "chatExamples" ? t("characterview.generating") : t("characterview.generate")}
        </Button>
      </div>

      <div className={`${scrollPaneCls} flex flex-1 flex-col gap-3 pr-2`}>
        {(d.messageExamples ?? []).map((convo, ci) => (
          <div
            key={convo.examples
              .map((msg) => `${msg.name}:${msg.content?.text ?? ""}`)
              .join("|")}
            className="rounded-xl border border-border/40 bg-black/10 p-4 shadow-inner backdrop-blur-sm"
          >
            <div className="mb-3 flex items-center justify-between border-b border-border/30 pb-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-muted">
                {t("characterview.conversation")} {ci + 1}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] font-bold text-muted transition-all hover:bg-danger/10 hover:text-danger"
                onClick={() => {
                  const updated = [...(d.messageExamples ?? [])];
                  updated.splice(ci, 1);
                  handleFieldEdit("messageExamples", updated);
                }}
              >
                {t("characterview.remove")}
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {convo.examples.map((msg, mi) => (
                <div
                  key={`${msg.name}:${msg.content?.text ?? ""}`}
                  className="flex items-center gap-3"
                >
                  <span
                    className={`w-12 shrink-0 text-right text-[11px] font-bold uppercase tracking-wider ${msg.name === "{{user1}}" ? "text-muted" : "text-accent"}`}
                  >
                    {msg.name === "{{user1}}" ? t("characterview.user") : t("characterview.agent")}
                  </span>
                  <Input
                    type="text"
                    value={msg.content?.text ?? ""}
                    onChange={(e) => {
                      const updated = [...(d.messageExamples ?? [])];
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
                    className="h-9 flex-1 rounded-lg border-border/50 bg-bg/50 text-xs shadow-inner backdrop-blur-md transition-all focus-visible:border-accent/50 focus-visible:ring-accent/50"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        {(d.messageExamples ?? []).length === 0 && (
          <div
            className={`${hintCls} rounded-xl border border-white/5 bg-black/5 py-3 text-center`}
          >
            {t("characterview.noChatExamplesYet")}
          </div>
        )}
      </div>
    </div>
  );
  const postExamplesPanel = (
    <div
      className={`${editorCardCls} max-h-[calc(100vh-14rem)] overflow-y-auto`}
      data-testid="character-post-examples-card"
    >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border/40 pb-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="text-sm font-bold tracking-wide text-txt">
            {t("characterview.postExamples")}
          </div>
          <span className="rounded-full border border-white/5 bg-black/10 px-2 py-0.5 text-[11px] font-medium text-muted">
            {t("characterview.SocialMediaVoice")}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 border-border/50 bg-bg/50 text-[11px] font-bold text-accent shadow-inner transition-all hover:border-accent/40 hover:text-accent"
          onClick={() => void handleGenerate("postExamples", "replace")}
          disabled={generating === "postExamples"}
        >
          {generating === "postExamples" ? t("characterview.generating") : t("characterview.generate")}
        </Button>
      </div>

      <div className={`${scrollPaneCls} flex flex-1 flex-col gap-2 pr-2`}>
        {(d.postExamples ?? []).map((post: string, pi: number) => (
          <div key={post || `post-${pi}`} className="flex items-center gap-2">
            <Input
              type="text"
              value={post}
              onChange={(e) => {
                const updated = [...(d.postExamples ?? [])];
                updated[pi] = e.target.value;
                handleFieldEdit("postExamples", updated);
              }}
              className="h-9 flex-1 rounded-lg border-border/50 bg-bg/50 text-xs shadow-inner backdrop-blur-md transition-all focus-visible:border-accent/50 focus-visible:ring-accent/50"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted hover:bg-danger/10 hover:text-danger"
              onClick={() => {
                const updated = [...(d.postExamples ?? [])];
                updated.splice(pi, 1);
                handleFieldEdit("postExamples", updated);
              }}
            >
              ×
            </Button>
          </div>
        ))}
        {(d.postExamples ?? []).length === 0 && (
          <div
            className={`${hintCls} rounded-xl border border-white/5 bg-black/5 py-3 text-center`}
          >
            {t("characterview.noPostExamplesYet")}
          </div>
        )}
      </div>

      <div className="border-t border-border/40 pt-4">
        <Button
          variant="ghost"
          size="sm"
          className="self-start rounded-md border border-transparent text-[11px] font-bold text-accent transition-all hover:border-accent/30 hover:bg-accent/10"
          onClick={() => {
            const updated = [...(d.postExamples ?? []), ""];
            handleFieldEdit("postExamples", updated);
          }}
        >
          {t("characterview.AddPost")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className={rootCls}>
      {/* ═══ ON-CHAIN IDENTITY ═══ */}
      {hasWallet && (
        <div className={sectionCls}>
          {!isRegistered && !dropLive && (
            <div className="flex flex-col gap-3">
              <div className="text-[12px] text-[var(--muted)]">
                {t("characterview.RegisterYourAgent")}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn text-xs py-[5px] px-4 !mt-0 cursor-pointer"
                  disabled={registryRegistering || registryLoading}
                  onClick={() => void registerOnChain()}
                >
                  {registryRegistering ? t("characterview.registering") : t("characterview.registerNow")}
                </button>
                {registryError && (
                  <span className="text-xs text-[var(--danger,#e74c3c)]">
                    {registryError}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {isRegistered &&
        (() => {
          const currentName = characterDraft?.name || d.name || "";
          const onChainName = registryStatus.agentName || "";
          const nameOutOfSync =
            currentName && onChainName && currentName !== onChainName;
          return (
            <div className={sectionCls}>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-green-400 font-bold tracking-wide">
                    {t("characterview.Registered")}
                  </span>
                  <span className="text-muted/50">|</span>
                  <span className="text-muted font-medium">
                    {t("characterview.Token")}
                    {registryStatus.tokenId}
                  </span>
                  <span className="text-muted/50">|</span>
                  <span className="text-txt font-semibold">{onChainName}</span>
                </div>
                {nameOutOfSync && (
                  <div className="flex items-center gap-3 bg-amber-400/10 border border-amber-400/20 px-3 py-2 rounded-lg">
                    <span className="text-[11px] text-amber-400/80 font-medium tracking-wide">
                      {t("characterview.OnChainName")}{" "}
                      <strong className="text-amber-400">{onChainName}</strong>{" "}
                      {t("characterview.DiffersFrom")}{" "}
                      <strong className="text-amber-400">{currentName}"</strong>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-[10px] h-6 px-2.5 border-amber-400/50 text-amber-400 hover:bg-amber-400/20 transition-all font-bold"
                      disabled={registryRegistering}
                      onClick={() => void syncRegistryProfile()}
                    >
                      {registryRegistering ? t("characterview.syncing") : t("characterview.syncToChain")}
                    </Button>
                  </div>
                )}
                {registryError && (
                  <span className="text-xs text-[var(--danger,#e74c3c)]">
                    {registryError}
                  </span>
                )}
                <a
                  href={`https://etherscan.io/token/${registryStatus.walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] underline text-[var(--accent)]"
                >
                  {t("characterview.viewOnEtherscan")}
                </a>
              </div>
            </div>
          );
        })()}

      {hasWallet && userMinted && !isRegistered && (
        <div className={sectionCls}>
          <div className="text-[12px] text-[var(--ok,#16a34a)]">
            {t("characterview.MintedFromCollecti")}
          </div>
        </div>
      )}

      {!customOverridesEnabled ? (
        <CharacterRoster
          entries={visibleCharacterRoster}
          selectedId={selectedCharacterId}
          onSelect={handleSelectCharacter}
          variant={sceneOverlay ? "onboarding" : "editor"}
          testIdPrefix="character"
        />
      ) : null}

      {customOverridesEnabled && (
        <div className="mt-3 flex flex-col gap-4">
          <div
            className="flex items-center justify-end gap-3"
            data-testid="character-edit-toolbar"
          >
            <div className="inline-flex items-center gap-2">
              <Button
                type="button"
                variant={customizeStep !== "examples" ? "default" : "outline"}
                size="sm"
                className="ce-save-btn"
                onClick={() => setCustomizeStep("core")}
              >
                {t("characterview.StyleRules")}
              </Button>
              <Button
                type="button"
                variant={customizeStep === "examples" ? "default" : "outline"}
                size="sm"
                className="ce-save-btn"
                onClick={() => setCustomizeStep("examples")}
              >
                {t("characterview.examples")}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ce-save-btn"
              onClick={() => {
                if (activeRosterEntry) {
                  applyCharacterDefaults(activeRosterEntry);
                }
              }}
              data-testid="character-reset-btn"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("characterview.reset")}
            </Button>
          </div>

          {customizeStep === "examples" ? (
            <div
              className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)_minmax(0,24rem)] xl:items-start xl:gap-6"
              data-testid="character-examples-grid"
            >
              {chatExamplesPanel}
              <div aria-hidden className="hidden xl:block" />
              {postExamplesPanel}
            </div>
          ) : (
            <div
              className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,23rem)_minmax(0,1fr)_minmax(0,32rem)] xl:items-start xl:gap-6"
              data-testid="character-customize-grid"
            >
              {coreFieldsPanel}
              <div aria-hidden className="hidden xl:block" />
              {styleEditorPanel}
            </div>
          )}
        </div>
      )}

      <div className={`${sectionCls} relative z-10`}>
        {(characterSaveSuccess || combinedSaveError) && (
          <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
            {characterSaveSuccess && (
              <span className="rounded-lg border border-green-400/20 bg-green-400/10 px-3 py-1.5 text-xs font-bold text-green-400">
                {characterSaveSuccess}
              </span>
            )}
            {combinedSaveError && (
              <span className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger">
                {combinedSaveError}
              </span>
            )}
          </div>
        )}

        <div className="relative flex flex-col gap-3 md:min-h-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center justify-center md:justify-start">
            {customOverridesEnabled && (
              <div
                className="flex min-w-0 items-center gap-2"
                data-testid="character-voice-picker"
              >
                <Button
                  type="button"
                  variant={voiceSelectionLocked ? "default" : "outline"}
                  size="icon"
                  className="h-8 w-8 rounded-full border-border/50 bg-bg/65 p-0 shadow-inner backdrop-blur-sm"
                  onClick={() => setVoiceSelectionLocked((value) => !value)}
                  aria-label={
                    voiceSelectionLocked
                      ? t("characterview.unlockVoiceSelection")
                      : t("characterview.lockVoiceSelection")
                  }
                  title={
                    voiceSelectionLocked
                      ? t("characterview.voicePinnedHint")
                      : t("characterview.lockVoiceHint")
                  }
                >
                  {voiceSelectionLocked ? (
                    <Lock className="h-3.5 w-3.5" />
                  ) : (
                    <LockOpen className="h-3.5 w-3.5" />
                  )}
                </Button>
                <ThemedSelect
                  value={voiceSelectValue}
                  groups={getVoiceSelectGroups(t)}
                  onChange={(id) => {
                    const preset = PREMADE_VOICES.find(
                      (voicePreset) => voicePreset.id === id,
                    );
                    if (preset) handleSelectPreset(preset);
                  }}
                  placeholder={t("characterview.selectAVoice")}
                  menuPlacement="top"
                  className="min-w-0 w-[7rem] sm:w-[11rem]"
                  triggerClassName="h-8 rounded-full border-border/50 bg-bg/65 px-4 py-0 text-[11px] shadow-inner backdrop-blur-sm"
                  menuClassName="border-border/60 bg-bg/92 shadow-2xl backdrop-blur-md"
                />
                <Button
                  type="button"
                  variant={voiceTesting ? "destructive" : "outline"}
                  size="icon"
                  className="h-8 w-8 rounded-full border-border/50 bg-bg/65 p-0 shadow-inner backdrop-blur-sm"
                  onClick={() =>
                    voiceTesting
                      ? handleStopTest()
                      : activeVoicePreset
                        ? handleTestVoice(activeVoicePreset.previewUrl)
                        : undefined
                  }
                  aria-label={
                    voiceTesting ? t("characterview.stopVoicePreview") : t("characterview.previewVoice")
                  }
                  title={
                    voiceTesting ? t("characterview.stopVoicePreview") : t("characterview.previewVoice")
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
            )}
          </div>

          <Button
            size="lg"
            className="ce-save-btn"
            disabled={characterSaving || voiceSaving}
            onClick={() => void handleSaveAll()}
          >
            {characterSaving || voiceSaving ? (
              t("characterview.saving")
            ) : (
              <>
                {t("characterview.save")}
              </>
            )}
          </Button>

          <Button
            type="button"
            variant={customOverridesEnabled ? "outline" : "default"}
            size="sm"
            className="ce-save-btn"
            onClick={() =>
              handleCustomOverridesChange(!customOverridesEnabled)
            }
            data-testid="character-customize-toggle"
          >
            {customizationActionLabel}
          </Button>

        </div>
      </div>
    </div>
  );
}

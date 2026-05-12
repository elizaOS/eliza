import { getStylePresets } from "@elizaos/shared";
import type { CharacterData } from "../../api/client";
import { client } from "../../api/client";
import {
  APP_EMOTE_EVENT,
  dispatchWindowEvent,
  VOICE_CONFIG_UPDATED_EVENT,
} from "../../events/index";
import { useChatAvatarVoiceBridge, useVoiceChat } from "../../hooks";
import { useApp } from "../../state/useApp";
import { normalizeCharacterMessageExamples } from "../../utils/character-message-examples";
import {
  hasConfiguredApiKey,
  PREMADE_VOICES,
  sanitizeApiKey,
} from "../../voice/types";
import { DocumentsView } from "../pages/DocumentsView";
import {
  CharacterExamplesPanel,
  CharacterIdentityPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";
import { CharacterHubView } from "./CharacterHubView";
import {
  CharacterRoster,
  type CharacterRosterEntry,
  createCustomPackRosterEntry,
  resolveRosterEntries,
} from "./CharacterRoster";
import {
  buildCharacterDraftFromPreset,
  getOnboardingPresetStyles,
  type OnboardingPreset,
  shouldApplyPresetDefaults,
} from "./character-editor-helpers";
import { resolveCharacterGreetingAnimation } from "./character-greeting";
import {
  buildVoiceConfigForCharacterEntry,
  type CharacterEditorVoiceConfig,
  DEFAULT_ELEVEN_FAST_MODEL,
} from "./character-voice-config";

/* Inline SVG icon helpers – avoids adding lucide-react as a dependency. */
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
const Icon = ({ className, d }: { className?: string; d: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <path d={d} />
  </svg>
);

const DownloadIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"
  />
);

const UploadIcon = ({ className }: { className?: string }) => (
  <Icon
    className={className}
    d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"
  />
);

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@elizaos/ui";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/* ── Shared accent styles ────────────────────────────────────────── */
const accentGradientStyle = {
  background:
    "linear-gradient(180deg, color-mix(in srgb, var(--accent) 92%, white 8%) 0%, var(--accent) 100%)",
  color: "var(--accent-foreground, #1a1f26)",
  borderColor: "rgba(var(--accent-rgb, 240, 185, 11), 0.5)",
  boxShadow:
    "0 0 14px rgba(var(--accent-rgb, 240, 185, 11), 0.16), inset 0 1px 0 var(--soft-white-glow)",
} as const;

const idleSaveBtnStyle = {
  background:
    "linear-gradient(180deg, rgba(var(--accent-rgb,240,185,11),0.16) 0%, rgba(var(--accent-rgb,240,185,11),0.1) 100%)",
  color: "rgba(var(--accent-rgb, 240, 185, 11), 0.78)",
  borderColor: "rgba(var(--accent-rgb, 240, 185, 11), 0.22)",
  boxShadow: "none",
} as const;

const pageTabsBoxShadow =
  "0 10px 26px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.05)";

/* ── Constants ─────────────────────────────────────────────────────── */

const CHARACTER_EDITOR_PAGES = [
  "personality",
  "style",
  "examples",
  "documents",
] as const;
type CharacterEditorPage = (typeof CHARACTER_EDITOR_PAGES)[number];

/**
 * Cheap structural check — returns true when value already has the
 * { examples: { name, content: { text } }[] }[] shape the UI expects.
 * Used to skip `normalizeCharacterMessageExamples`, which strips empty
 * turns that the user is actively composing.
 */
function hasValidMessageExamplesShape(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((convo) => {
    if (!convo || typeof convo !== "object") return false;
    const examples = (convo as { examples?: unknown }).examples;
    if (!Array.isArray(examples)) return false;
    return examples.every((msg) => {
      if (!msg || typeof msg !== "object") return false;
      const name = (msg as { name?: unknown }).name;
      const content = (msg as { content?: unknown }).content;
      return (
        typeof name === "string" &&
        !!content &&
        typeof content === "object" &&
        typeof (content as { text?: unknown }).text === "string"
      );
    });
  });
}

/* ── Component ─────────────────────────────────────────────────────── */

export function CharacterEditor({
  sceneOverlay = false,
  inModal: _inModal = false,
  onHeaderActionsChange,
}: {
  sceneOverlay?: boolean;
  inModal?: boolean;
  onHeaderActionsChange?: (actions: ReactNode | null) => void;
} = {}) {
  const {
    tab,
    setTab,
    characterData,
    characterDraft,
    characterLoading,
    characterSaving,
    characterSaveSuccess,
    chatAgentVoiceMuted: _chatAgentVoiceMuted,
    characterSaveError,
    handleCharacterFieldInput,
    handleCharacterStyleInput,
    handleSaveCharacter,
    loadCharacter,
    setState,
    onboardingOptions,
    selectedVrmIndex,
    customVrmUrl: _customVrmUrl,
    customVrmPreviewUrl,
    customCatchphrase,
    customVoicePresetId,
    activePackId,
    t,
    uiLanguage,
    registryStatus: _registryStatus,
    registryLoading: _registryLoading,
    registryRegistering: _registryRegistering,
    registryError: _registryError,
    dropStatus: _dropStatus,
    loadRegistryStatus,
    registerOnChain: _registerOnChain,
    syncRegistryProfile: _syncRegistryProfile,
    loadDropStatus,
    walletConfig: _walletConfig,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
  } = useApp();

  /** ElevenLabs voices are available only when direct key or cloud voice routing is active. */
  const useElevenLabs = elizaCloudConnected || elizaCloudVoiceProxyAvailable;

  useEffect(() => {
    void loadCharacter();
    void loadRegistryStatus();
    void loadDropStatus();
  }, [loadCharacter, loadRegistryStatus, loadDropStatus]);

  const handleFieldEdit = useCallback(
    (field: string, value: unknown) => {
      if (!suppressDirtyRef.current) setFieldsEdited(true);
      handleCharacterFieldInput(
        field as keyof CharacterData,
        value as CharacterData[keyof CharacterData],
      );
    },
    [handleCharacterFieldInput],
  );

  const handleStyleEdit = useCallback(
    (key: "all" | "chat" | "post", value: string) => {
      if (!suppressDirtyRef.current) setFieldsEdited(true);
      handleCharacterStyleInput(key, value);
    },
    [handleCharacterStyleInput],
  );

  const [activePage, setActivePage] = useState<CharacterEditorPage>(
    tab === "documents" ? "documents" : "personality",
  );
  const [rightTab, setRightTab] = useState<"style" | "examples">("style");
  const [customizing, setCustomizing] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    | { kind: "page"; page: CharacterEditorPage }
    | { kind: "character"; entry: CharacterRosterEntry }
    | null
  >(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Sync rightTab with activePage (for overlay mode's right panel toggle)
  useEffect(() => {
    if (activePage === "style") setRightTab("style");
    else if (activePage === "examples") setRightTab("examples");
  }, [activePage]);

  // Sync activePage when tab changes externally (e.g. nav to /documents)
  useEffect(() => {
    if (tab === "documents" && activePage !== "documents") {
      setActivePage("documents");
    }
  }, [tab, activePage]);

  /* ── Style entry state ──────────────────────────────────────────── */
  const [pendingStyleEntries, setPendingStyleEntries] = useState<
    Record<string, string>
  >({ all: "", chat: "", post: "" });
  const [styleEntryDrafts, setStyleEntryDrafts] = useState<
    Record<string, string[]>
  >({ all: [], chat: [], post: [] });

  /* ── Roster state ───────────────────────────────────────────────── */
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(
    null,
  );
  /** The character ID that was last saved or loaded from the server. */
  const [savedCharacterId, setSavedCharacterId] = useState<string | null>(null);
  /** Tracks whether character fields have been edited since last save/load. */
  const [fieldsEdited, setFieldsEdited] = useState(false);
  /** Ref to suppress dirty-tracking during programmatic field updates. */
  const suppressDirtyRef = useRef(false);
  /** Queued greeting to play after VRM teleport-in dissolve finishes. */
  const pendingGreetingRef = useRef<{
    characterId: string;
    catchphrase: string;
    animationPath: string | null;
  } | null>(null);
  const onboardingPresetStyles = useMemo(
    () => getOnboardingPresetStyles(onboardingOptions),
    [onboardingOptions],
  );
  const [rosterStyles, setRosterStyles] = useState<OnboardingPreset[]>([
    ...onboardingPresetStyles,
  ]);

  /* ── Voice config state ─────────────────────────────────────────── */
  const [voiceConfig, setVoiceConfig] = useState<CharacterEditorVoiceConfig>(
    {},
  );

  const handleChatAvatarSpeakingChange = useCallback(
    (isSpeaking: boolean) => {
      setState("chatAvatarSpeaking", isSpeaking);
    },
    [setState],
  );

  const voice = useVoiceChat({
    cloudConnected: useElevenLabs,
    interruptOnSpeech: false,
    lang: "en-US",
    voiceConfig,
    onTranscript: () => {},
  });

  useChatAvatarVoiceBridge({
    mouthOpen: voice.mouthOpen,
    isSpeaking: voice.isSpeaking,
    usingAudioAnalysis: voice.usingAudioAnalysis,
    onSpeakingChange: handleChatAvatarSpeakingChange,
  });
  const [, setVoiceLoading] = useState(false);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceSaveError, setVoiceSaveError] = useState<string | null>(null);
  const [, setSelectedVoicePresetId] = useState<string | null>(null);
  const [voiceSelectionLocked] = useState(false);
  const activeCharacterIdRef = useRef<string | null>(null);

  /* ── Load roster ────────────────────────────────────────────────── */
  // Use static STYLE_PRESETS shipped in the frontend bundle — no API call
  // needed. If the server provides styles via onboardingOptions, prefer those.
  useEffect(() => {
    const localizedPresets = getStylePresets(uiLanguage);
    if (onboardingPresetStyles.length) {
      const merged = onboardingPresetStyles.map((serverPreset) => {
        const localMeta = localizedPresets.find(
          (p) =>
            p.id === serverPreset.id ||
            p.name === serverPreset.name ||
            p.avatarIndex === serverPreset.avatarIndex,
        );
        return {
          ...serverPreset,
          id: localMeta?.id ?? serverPreset.id,
          name: localMeta?.name ?? serverPreset.name,
          avatarIndex: localMeta?.avatarIndex,
          voicePresetId: localMeta?.voicePresetId,
          greetingAnimation: localMeta?.greetingAnimation,
        } as OnboardingPreset;
      });
      setRosterStyles(merged);
    } else {
      setRosterStyles(localizedPresets);
    }
  }, [onboardingPresetStyles, uiLanguage]);

  const baseRosterEntries = useMemo(() => {
    const base = resolveRosterEntries(rosterStyles);
    if (activePackId && _customVrmUrl) {
      const customOnboardingName =
        typeof characterData?.name === "string" && characterData.name.trim()
          ? characterData.name
          : "Custom";
      base.unshift(
        createCustomPackRosterEntry({
          id: activePackId,
          name: customOnboardingName,
          previewUrl: customVrmPreviewUrl || undefined,
          catchphrase: customCatchphrase || undefined,
          voicePresetId: customVoicePresetId || undefined,
        }),
      );
    }
    return base;
  }, [
    rosterStyles,
    activePackId,
    _customVrmUrl,
    customVrmPreviewUrl,
    characterData?.name,
    customCatchphrase,
    customVoicePresetId,
  ]);

  // If the user renamed the selected character, reflect it in the roster
  const characterRoster = useMemo(() => {
    const activeId = selectedCharacterId ?? savedCharacterId;
    const draftName =
      typeof characterDraft.name === "string" ? characterDraft.name.trim() : "";
    if (!activeId || !draftName) return baseRosterEntries;
    return baseRosterEntries.map((entry) =>
      entry.id === activeId ? { ...entry, name: draftName } : entry,
    );
  }, [
    baseRosterEntries,
    selectedCharacterId,
    savedCharacterId,
    characterDraft.name,
  ]);

  const d = characterDraft;
  const fallbackCharacterName =
    (typeof d.name === "string" && d.name.trim()) ||
    (typeof characterData?.name === "string" && characterData.name.trim()) ||
    "Agent";
  const normalizedMessageExamples = Array.isArray(d.messageExamples)
    ? hasValidMessageExamplesShape(d.messageExamples)
      ? (d.messageExamples as ReturnType<
          typeof normalizeCharacterMessageExamples
        >)
      : normalizeCharacterMessageExamples(
          d.messageExamples,
          fallbackCharacterName,
        )
    : [];
  const bioText =
    typeof d.bio === "string"
      ? d.bio
      : Array.isArray(d.bio)
        ? (d.bio as string[]).join("\n")
        : "";

  const hasCharacterContent = (c: unknown) =>
    Boolean(c && Object.keys(c as Record<string, unknown>).length > 0);
  const currentCharacter = hasCharacterContent(characterDraft)
    ? characterDraft
    : characterData;

  /* ── Resolve active roster entry ────────────────────────────────── */
  const activeCharacterRosterEntry: CharacterRosterEntry | null =
    useMemo(() => {
      if (selectedCharacterId) {
        const found = characterRoster.find((e) => e.id === selectedCharacterId);
        if (found) return found;
      }
      const byVrm = characterRoster.find(
        (e) => e.avatarIndex === selectedVrmIndex,
      );
      if (byVrm) return byVrm;

      if (!currentCharacter) return null;
      const currentName =
        typeof currentCharacter.name === "string"
          ? currentCharacter.name.trim()
          : "";
      const byName = characterRoster.find((e) => e.name === currentName);
      if (byName) return byName;
      return null;
    }, [
      characterRoster,
      currentCharacter,
      selectedCharacterId,
      selectedVrmIndex,
    ]);

  /* ── Seed savedCharacterId from server data on first load ────────── */
  useEffect(() => {
    if (savedCharacterId) return; // already set
    if (!activeCharacterRosterEntry) return;
    // Only set when derived from server data (no user selection yet)
    if (!selectedCharacterId) {
      setSavedCharacterId(activeCharacterRosterEntry.id);
    }
  }, [activeCharacterRosterEntry, savedCharacterId, selectedCharacterId]);

  /** True when the user has made changes that haven't been saved yet. */
  const hasPendingChanges =
    fieldsEdited ||
    (selectedCharacterId !== null && selectedCharacterId !== savedCharacterId);

  useEffect(() => {
    if (!hasPendingChanges) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasPendingChanges]);

  useEffect(() => {
    if (!Array.isArray(d.messageExamples) || d.messageExamples.length === 0) {
      return;
    }

    // Skip normalization when the draft already has the expected shape —
    // otherwise empty turns the user just added (blank text) get stripped
    // out before they can type into them.
    if (hasValidMessageExamplesShape(d.messageExamples)) return;

    const normalized = normalizeCharacterMessageExamples(
      d.messageExamples,
      fallbackCharacterName,
    );

    if (JSON.stringify(d.messageExamples) === JSON.stringify(normalized)) {
      return;
    }

    suppressDirtyRef.current = true;
    handleFieldEdit("messageExamples", normalized);
    queueMicrotask(() => {
      suppressDirtyRef.current = false;
    });
  }, [d.messageExamples, fallbackCharacterName, handleFieldEdit]);

  /* ── Load voice config on mount ─────────────────────────────────── */
  /* Load voice config from server — but don't overwrite a roster-derived
     voice preset that was already applied by auto-select. */
  const voicePresetAppliedRef = useRef(false);
  useEffect(() => {
    void (async () => {
      setVoiceLoading(true);
      try {
        const cfg = await client.getConfig();
        type MessagesConfig = { tts?: CharacterEditorVoiceConfig };
        const messages = cfg.messages as MessagesConfig | undefined;
        const tts = messages?.tts;
        if (tts) {
          const serverElevenlabsVoiceId =
            typeof tts.elevenlabs === "object" ? tts.elevenlabs.voiceId : null;
          setVoiceConfig((prev) => {
            if (!voicePresetAppliedRef.current) {
              return tts;
            }
            const serverElevenlabs =
              typeof tts.elevenlabs === "object" ? tts.elevenlabs : {};
            const currentElevenlabs =
              typeof prev.elevenlabs === "object" ? prev.elevenlabs : {};
            const serverEdge = typeof tts.edge === "object" ? tts.edge : {};
            const currentEdge = typeof prev.edge === "object" ? prev.edge : {};
            return {
              ...tts,
              ...prev,
              elevenlabs: {
                ...serverElevenlabs,
                ...currentElevenlabs,
              },
              edge: {
                ...serverEdge,
                ...currentEdge,
              },
            };
          });
          // Only set the voice preset from server if a roster entry hasn't
          // already set one (roster voice takes precedence).
          if (serverElevenlabsVoiceId && !voicePresetAppliedRef.current) {
            const preset = PREMADE_VOICES.find(
              (p) => p.voiceId === serverElevenlabsVoiceId,
            );
            setSelectedVoicePresetId(preset?.id ?? null);
          }
        }
      } catch (err) {
        console.warn("[CharacterEditor] Failed to load voice config:", err);
      }
      setVoiceLoading(false);
    })();
  }, []);

  /* ── Voice helpers ──────────────────────────────────────────────── */
  const applyVoicePresetForEntry = useCallback(
    (entry: CharacterRosterEntry) => {
      setVoiceSaveError(null);
      const nextVoiceSelection = buildVoiceConfigForCharacterEntry({
        entry,
        useElevenLabs,
        voiceConfig,
      });
      if (!nextVoiceSelection) return null;
      setSelectedVoicePresetId(nextVoiceSelection.selectedVoicePresetId);
      setVoiceConfig(nextVoiceSelection.nextVoiceConfig);
      voicePresetAppliedRef.current = true;
      return nextVoiceSelection.persistedVoiceConfig;
    },
    [useElevenLabs, voiceConfig],
  );

  /* ── Character defaults ─────────────────────────────────────────── */
  const applyCharacterDefaults = useCallback(
    (entry: CharacterRosterEntry) => {
      const next = buildCharacterDraftFromPreset(entry);
      handleFieldEdit("name", next.name ?? "");
      handleFieldEdit("username", next.username ?? "");
      handleFieldEdit("bio", next.bio ?? "");
      handleFieldEdit("system", next.system ?? "");
      handleFieldEdit("adjectives", next.adjectives ?? []);
      handleFieldEdit("style", next.style ?? { all: [], chat: [], post: [] });
      handleFieldEdit("messageExamples", next.messageExamples ?? []);
      handleFieldEdit("postExamples", next.postExamples ?? []);
    },
    [handleFieldEdit],
  );

  const commitCharacterSelection = useCallback(
    (entry: CharacterRosterEntry, applyDefaults: boolean) => {
      const isNewCharacter = selectedCharacterId !== entry.id;
      setSelectedCharacterId(entry.id);
      setState("selectedVrmIndex", entry.avatarIndex);
      if (!voiceSelectionLocked && isNewCharacter) {
        const persistedVoiceConfig = applyVoicePresetForEntry(entry);
        if (persistedVoiceConfig) {
          dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, persistedVoiceConfig);
          // Persist the voice switch immediately so the next assistant line
          // uses the selected character's voice without waiting for Save.
          void client
            .updateConfig({
              messages: {
                tts: persistedVoiceConfig,
              },
            })
            .catch(() => {});
        }
      }
      if (applyDefaults) {
        applyCharacterDefaults(entry);
      }

      if (isNewCharacter && entry.catchphrase) {
        // Immediate cleanup of old character's speech
        voice.stopSpeaking();

        // Queue greeting animation to play after the VRM teleport-in dissolve finishes
        pendingGreetingRef.current = {
          characterId: entry.id,
          catchphrase: entry.catchphrase,
          animationPath: resolveCharacterGreetingAnimation({
            avatarIndex: entry.avatarIndex,
            greetingAnimation: entry.greetingAnimation,
          }),
        };
      }
      activeCharacterIdRef.current = entry.id;
    },
    [
      applyCharacterDefaults,
      applyVoicePresetForEntry,
      selectedCharacterId,
      setState,
      voiceSelectionLocked,
      voice,
    ],
  );

  const requestPageChange = useCallback(
    (page: CharacterEditorPage) => {
      if (page === activePage) return;
      if (hasPendingChanges) {
        setPendingNavigation({ kind: "page", page });
        return;
      }
      setActivePage(page);
      if (page === "style" || page === "examples") setRightTab(page);
    },
    [activePage, hasPendingChanges],
  );

  const requestCharacterSelection = useCallback(
    (entry: CharacterRosterEntry) => {
      if (entry.id === selectedCharacterId) return;
      if (hasPendingChanges) {
        setPendingNavigation({ kind: "character", entry });
        return;
      }
      commitCharacterSelection(entry, true);
    },
    [commitCharacterSelection, hasPendingChanges, selectedCharacterId],
  );

  /* ── Select character from roster ───────────────────────────────── */
  const handleSelectCharacter = useCallback(
    (entry: CharacterRosterEntry) => {
      requestCharacterSelection(entry);
    },
    [requestCharacterSelection],
  );

  /* ── Auto-select on mount ───────────────────────────────────────── */
  useEffect(() => {
    if (
      characterLoading ||
      selectedCharacterId ||
      !characterRoster.length ||
      !currentCharacter
    )
      return;
    // Only apply defaults from the roster entry if this character is completely empty,
    // OR if the user has navigated to a different preset character than the one that's
    // saved (e.g. selected Momo in the roster but Chen is saved — show Momo's data).
    // Never wipe data for a custom/unnamed character that doesn't match any roster entry.
    const isNamed =
      typeof currentCharacter.name === "string" &&
      currentCharacter.name.trim().length > 0;
    const hasBioOrSystem = Boolean(
      currentCharacter.bio ||
        ("system" in currentCharacter &&
          typeof currentCharacter.system === "string" &&
          currentCharacter.system),
    );
    const hasMeaningfulContent = isNamed || hasBioOrSystem;

    const entry =
      activeCharacterRosterEntry ??
      (!hasMeaningfulContent ? characterRoster[0] : null);
    if (!entry) return;

    // Apply preset defaults if: no saved content, OR the active VRM character
    // differs from what's saved (name mismatch means user switched presets).
    const applyDefaults = shouldApplyPresetDefaults(
      hasMeaningfulContent,
      currentCharacter.name,
      entry.name,
    );

    // Suppress dirty-tracking during programmatic auto-select
    suppressDirtyRef.current = true;
    commitCharacterSelection(entry, applyDefaults);
    suppressDirtyRef.current = false;
    // Mark this auto-selection as the saved baseline (not a user change)
    setSavedCharacterId(entry.id);
  }, [
    characterLoading,
    characterRoster,
    commitCharacterSelection,
    currentCharacter,
    selectedCharacterId,
    activeCharacterRosterEntry,
  ]);

  /* ── Play greeting animation + catchphrase when VRM teleport-in dissolve finishes ── */
  const greetingTimerRef = useRef<number | null>(null);

  // Clear any stale greeting timer before queueing a new one on character change
  useEffect(() => {
    if (greetingTimerRef.current != null) {
      window.clearTimeout(greetingTimerRef.current);
      greetingTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!sceneOverlay) return;
    const handler = () => {
      const greeting = pendingGreetingRef.current;
      if (!greeting) return;
      // Do not play a queued greeting if the user has already switched away
      if (greeting.characterId !== activeCharacterIdRef.current) return;

      pendingGreetingRef.current = null;
      // Delay the emote dispatch so the idle animation can fully settle
      // after the teleport dissolve before we cross-fade into the greeting.
      if (greetingTimerRef.current != null) {
        window.clearTimeout(greetingTimerRef.current);
      }
      greetingTimerRef.current = window.setTimeout(() => {
        greetingTimerRef.current = null;
        if (greeting.characterId !== activeCharacterIdRef.current) return;

        if (greeting.animationPath) {
          dispatchWindowEvent(APP_EMOTE_EVENT, {
            emoteId: "greeting",
            path: `/${greeting.animationPath}`,
            duration: 3,
            loop: false,
            showOverlay: false,
          });
        }
        voice.speak(greeting.catchphrase);
      }, 400);
    };
    const eventName = "eliza:vrm-teleport-complete";
    window.addEventListener(eventName, handler);
    return () => {
      window.removeEventListener(eventName, handler);
      if (greetingTimerRef.current != null) {
        window.clearTimeout(greetingTimerRef.current);
        greetingTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.speak, sceneOverlay]);

  /* ── Dispatch camera offset for editor panel ─────────────────────── */
  useEffect(() => {
    if (!sceneOverlay || typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 768px)");
    const isEditorTab = tab === "character" || tab === "character-select";
    const dispatch = () => {
      const offset = isEditorTab && !mql.matches ? 0.85 : 0;
      window.dispatchEvent(
        new CustomEvent("eliza:editor-camera-offset", {
          detail: { offset },
        }),
      );
    };
    dispatch();
    const onChange = () => dispatch();
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      window.dispatchEvent(
        new CustomEvent("eliza:editor-camera-offset", {
          detail: { offset: 0 },
        }),
      );
    };
  }, [tab, sceneOverlay]);

  /* ── Sync style entry drafts ────────────────────────────────────── */
  useEffect(() => {
    setStyleEntryDrafts({
      all: [...(d.style?.all ?? [])],
      chat: [...(d.style?.chat ?? [])],
      post: [...(d.style?.post ?? [])],
    });
  }, [d.style]);

  /* ── Voice test ─────────────────────────────────────────────────── */

  /* ── Persist voice config ───────────────────────────────────────── */
  const persistVoiceConfig = useCallback(async () => {
    setVoiceSaveError(null);
    const provider =
      voiceConfig.provider ?? (useElevenLabs ? "elevenlabs" : "edge");
    let normalizedVoiceConfig: Record<string, unknown>;
    if (provider === "edge") {
      normalizedVoiceConfig = {
        ...voiceConfig,
        provider: "edge",
        edge: voiceConfig.edge ?? {},
      };
    } else {
      const hasElevenLabsApiKey = hasConfiguredApiKey(
        (voiceConfig.elevenlabs as Record<string, string> | undefined)?.apiKey,
      );
      const defaultVoiceMode =
        typeof voiceConfig.mode === "string"
          ? voiceConfig.mode
          : useElevenLabs && !hasElevenLabsApiKey
            ? "cloud"
            : "own-key";
      const normalized: Record<string, string> = {
        ...(voiceConfig.elevenlabs as Record<string, string> | undefined),
        modelId:
          (voiceConfig.elevenlabs as Record<string, string> | undefined)
            ?.modelId ?? DEFAULT_ELEVEN_FAST_MODEL,
      };
      const sanitizedKey = sanitizeApiKey(normalized?.apiKey);
      if (sanitizedKey) normalized.apiKey = sanitizedKey;
      else delete normalized.apiKey;
      normalizedVoiceConfig = {
        ...voiceConfig,
        provider: "elevenlabs",
        mode: defaultVoiceMode,
        elevenlabs: normalized,
      };
    }
    await client.updateConfig({ messages: { tts: normalizedVoiceConfig } });
    dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, normalizedVoiceConfig);
  }, [voiceConfig, useElevenLabs]);

  /* ── Save all ───────────────────────────────────────────────────── */
  const handleSaveAll = useCallback(async () => {
    setVoiceSaving(true);
    setVoiceSaveError(null);
    try {
      await persistVoiceConfig();
    } catch (err) {
      setVoiceSaveError(
        err instanceof Error ? err.message : "Failed to save voice settings.",
      );
      setVoiceSaving(false);
      return false;
    }
    setVoiceSaving(false);
    try {
      await handleSaveCharacter();
    } catch {
      return false;
    }
    // Mark the current selection as saved
    setSavedCharacterId(
      selectedCharacterId ?? activeCharacterRosterEntry?.id ?? null,
    );
    setFieldsEdited(false);
    return true;
  }, [
    handleSaveCharacter,
    persistVoiceConfig,
    selectedCharacterId,
    activeCharacterRosterEntry,
  ]);

  /* ── Reset to defaults ──────────────────────────────────────────── */
  const handleResetToDefaults = useCallback(() => {
    if (!activeCharacterRosterEntry) return;
    applyCharacterDefaults(activeCharacterRosterEntry);
    applyVoicePresetForEntry(activeCharacterRosterEntry);
  }, [
    activeCharacterRosterEntry,
    applyCharacterDefaults,
    applyVoicePresetForEntry,
  ]);

  /* ── Export character JSON ────────────────────────────────────────── */
  const handleExportCharacter = useCallback(() => {
    const data = currentCharacter;
    if (!data) return;
    const fileName = `${
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim().replace(/\s+/g, "-").toLowerCase()
        : "character"
    }.json`;
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [currentCharacter]);

  const resolvePendingNavigation = useCallback(
    async (shouldSave: boolean) => {
      const target = pendingNavigation;
      if (!target) return;

      if (shouldSave) {
        const saved = await handleSaveAll();
        if (!saved) return;
      }

      setPendingNavigation(null);

      if (target.kind === "page") {
        setActivePage(target.page);
        if (target.page === "style" || target.page === "examples") {
          setRightTab(target.page);
        }
        return;
      }

      commitCharacterSelection(target.entry, true);
    },
    [commitCharacterSelection, handleSaveAll, pendingNavigation],
  );

  useEffect(() => {
    onHeaderActionsChange?.(null);
    return () => {
      onHeaderActionsChange?.(null);
    };
  }, [onHeaderActionsChange]);

  const renderContentActionButtons = (uploadInputId: string) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 rounded-xl"
        onClick={() => document.getElementById(uploadInputId)?.click()}
        title={t("aria.upload", {
          defaultValue: "Upload VRM",
        })}
        aria-label={t("aria.upload", {
          defaultValue: "Upload VRM",
        })}
      >
        <UploadIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 rounded-xl"
        onClick={handleExportCharacter}
        disabled={!currentCharacter}
        title={t("charactereditor.ExportJSON", {
          defaultValue: "Export JSON",
        })}
        aria-label={t("charactereditor.ExportJSON", {
          defaultValue: "Export JSON",
        })}
      >
        <DownloadIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 rounded-xl px-4 text-xs-tight font-semibold"
        onClick={handleResetToDefaults}
        disabled={!activeCharacterRosterEntry || !currentCharacter}
        title={t("charactereditor.ResetToDefaults", {
          defaultValue: "Reset to Defaults",
        })}
      >
        {t("common.reset", { defaultValue: "Reset" })}
      </Button>
      <Button
        size="sm"
        className="h-9 rounded-xl px-6 text-sm font-bold tracking-[0.05em] transition-[background-color,border-color,color,box-shadow,transform] duration-200 disabled:opacity-50"
        style={hasPendingChanges ? accentGradientStyle : idleSaveBtnStyle}
        disabled={
          characterSaving ||
          voiceSaving ||
          !hasPendingChanges ||
          !currentCharacter
        }
        onClick={() => void handleSaveAll()}
      >
        {characterSaving || voiceSaving
          ? t("charactereditor.Saving", { defaultValue: "saving..." })
          : t("common.save", { defaultValue: "Save" })}
      </Button>
    </div>
  );

  /* ── Style entry handlers ───────────────────────────────────────── */
  const handlePendingStyleEntryChange = useCallback(
    (key: string, value: string) => {
      setPendingStyleEntries((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleAddStyleEntry = useCallback(
    (key: string) => {
      const value = pendingStyleEntries[key].trim();
      if (!value) return;
      const nextItems = [...(d.style?.[key as "all" | "chat" | "post"] ?? [])];
      if (!nextItems.includes(value)) {
        nextItems.push(value);
        handleStyleEdit(key as "all" | "chat" | "post", nextItems.join("\n"));
      }
      setPendingStyleEntries((prev) => ({ ...prev, [key]: "" }));
    },
    [d.style, handleStyleEdit, pendingStyleEntries],
  );

  const handleRemoveStyleEntry = useCallback(
    (key: string, index: number) => {
      const nextItems = [...(d.style?.[key as "all" | "chat" | "post"] ?? [])];
      nextItems.splice(index, 1);
      handleStyleEdit(key as "all" | "chat" | "post", nextItems.join("\n"));
    },
    [d.style, handleStyleEdit],
  );

  const handleReorderStyleEntries = useCallback(
    (key: string, items: string[]) => {
      handleStyleEdit(key as "all" | "chat" | "post", items.join("\n"));
    },
    [handleStyleEdit],
  );

  const handleStyleEntryDraftChange = useCallback(
    (key: string, index: number, value: string) => {
      setStyleEntryDrafts((prev) => {
        const nextItems = [...(prev[key] ?? [])];
        nextItems[index] = value;
        return { ...prev, [key]: nextItems };
      });
    },
    [],
  );

  const handleCommitStyleEntry = useCallback(
    (key: string, index: number) => {
      const nextValue = styleEntryDrafts[key]?.[index]?.trim() ?? "";
      const nextItems = [...(d.style?.[key as "all" | "chat" | "post"] ?? [])];
      if (!nextValue) {
        nextItems.splice(index, 1);
      } else {
        nextItems[index] = nextValue;
      }
      handleStyleEdit(key as "all" | "chat" | "post", nextItems.join("\n"));
    },
    [d.style, handleStyleEdit, styleEntryDrafts],
  );

  /* ── Derived ────────────────────────────────────────────────────── */
  const combinedSaveError = voiceSaveError ?? characterSaveError;

  /* ── Loading state ──────────────────────────────────────────────── */
  if (characterLoading && !characterData) {
    return (
      <div
        className={
          sceneOverlay
            ? "relative flex flex-col justify-end w-full flex-1 gap-2 overflow-hidden select-none transition-[width,margin-left] duration-[400ms] ease-in-out [-webkit-tap-highlight-color:transparent] max-[600px]:overflow-visible"
            : "flex flex-col w-full flex-1 items-center justify-center"
        }
        data-no-camera-zoom={sceneOverlay ? "true" : undefined}
        data-no-camera-drag={sceneOverlay ? "true" : undefined}
        data-testid={sceneOverlay ? "companion-character-editor" : undefined}
      >
        <div className="text-muted text-sm">
          {t("charactereditor.LoadingCharacterData", {
            defaultValue: "Loading character data...",
          })}
        </div>
      </div>
    );
  }

  /* ── Render ─────────────────────────────────────────────────────── */
  return (
    <div
      className={
        sceneOverlay
          ? "absolute inset-0 z-10 flex flex-col pointer-events-none pt-[4.5rem] px-6 pb-3 max-md:px-3 max-md:pb-2 max-md:pt-[4.5rem] [&>*]:pointer-events-auto"
          : "flex flex-col w-full flex-1 min-h-0 gap-4"
      }
      data-no-camera-zoom={sceneOverlay ? "true" : undefined}
      data-no-camera-drag={sceneOverlay ? "true" : undefined}
      data-testid={sceneOverlay ? "companion-character-editor" : undefined}
      onWheel={sceneOverlay ? (e) => e.stopPropagation() : undefined}
    >
      <div
        className={
          sceneOverlay
            ? `relative flex flex-col justify-end w-full flex-1 gap-2 overflow-hidden select-none transition-[width,margin-left] duration-[400ms] ease-in-out [-webkit-tap-highlight-color:transparent] max-[600px]:overflow-visible [&_input]:select-text [&_textarea]:select-text [&_*:focus-visible:not(input):not(textarea)]:outline-none [&_*:focus-visible:not(input):not(textarea)]:shadow-none [&_button:focus-visible]:outline-none [&_button:focus-visible]:shadow-none${customizing ? " md:w-[40%] md:ml-auto" : ""}`
            : "relative flex min-h-0 w-full flex-1 flex-col select-none [&_input]:select-text [&_textarea]:select-text"
        }
      >
        {/* ── Companion overlay: Character Roster ────────────────────── */}
        {sceneOverlay && !customizing && (
          <div className="shrink min-h-0 overflow-hidden flex flex-col items-center justify-end w-full relative max-[600px]:!overflow-visible pointer-events-auto">
            <CharacterRoster
              entries={characterRoster}
              selectedId={
                selectedCharacterId ?? activeCharacterRosterEntry?.id ?? null
              }
              onSelect={handleSelectCharacter}
            />
          </div>
        )}

        {/* ── Companion overlay: tabbed editor (identity | style | examples) */}
        {sceneOverlay && customizing && (
          // biome-ignore lint/a11y/useSemanticElements: existing pattern
          <div
            className="flex flex-col flex-1 min-h-0 gap-2 overflow-hidden"
            role="region"
            aria-label={t("charactereditor.TabbedEditorGroupLabel", {
              defaultValue: "Character editor — tabbed sections",
            })}
          >
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <div
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-elevated p-1"
                style={{ boxShadow: pageTabsBoxShadow }}
                role="tablist"
                aria-label={t("charactereditor.TabbedEditorGroupLabel", {
                  defaultValue: "Character editor sections",
                })}
              >
                {CHARACTER_EDITOR_PAGES.map((page) => (
                  <button
                    key={page}
                    type="button"
                    id={`character-editor-tab-${page}`}
                    role="tab"
                    aria-selected={activePage === page}
                    aria-controls={`character-editor-panel-${page}`}
                    tabIndex={activePage === page ? 0 : -1}
                    className="flex-initial cursor-pointer rounded-md border border-transparent bg-transparent px-[0.6rem] py-1.5 text-center text-2xs font-bold uppercase tracking-[0.1em] text-txt transition-[background,border-color,color,box-shadow] duration-150 hover:border-border hover:bg-bg-hover hover:text-txt-strong"
                    style={
                      activePage === page ? accentGradientStyle : undefined
                    }
                    onClick={() => requestPageChange(page)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ArrowRight" &&
                        event.key !== "ArrowLeft" &&
                        event.key !== "Home" &&
                        event.key !== "End"
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const currentIndex =
                        CHARACTER_EDITOR_PAGES.indexOf(activePage);
                      const nextIndex =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? CHARACTER_EDITOR_PAGES.length - 1
                            : event.key === "ArrowRight"
                              ? (currentIndex + 1) %
                                CHARACTER_EDITOR_PAGES.length
                              : (currentIndex -
                                  1 +
                                  CHARACTER_EDITOR_PAGES.length) %
                                CHARACTER_EDITOR_PAGES.length;
                      const nextPage = CHARACTER_EDITOR_PAGES[nextIndex];
                      requestPageChange(nextPage);
                      requestAnimationFrame(() => {
                        globalThis.document
                          ?.getElementById(`character-editor-tab-${nextPage}`)
                          ?.focus();
                      });
                    }}
                  >
                    {page === "personality"
                      ? t("charactereditor.TabPersonality", {
                          defaultValue: "Personality",
                        })
                      : page === "style"
                        ? t("charactereditor.TabStyles", {
                            defaultValue: "Styles",
                          })
                        : page === "examples"
                          ? t("charactereditor.TabExamples", {
                              defaultValue: "Examples",
                            })
                          : t("nav.documents", {
                              defaultValue: "Knowledge",
                            })}
                  </button>
                ))}
              </div>
              {activePage !== "documents" && (
                <div className="ml-auto">
                  {renderContentActionButtons("ce-vrm-upload")}
                </div>
              )}
            </div>

            <div
              id={`character-editor-panel-${activePage}`}
              role="tabpanel"
              aria-labelledby={`character-editor-tab-${activePage}`}
              className="flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              <div
                className={`custom-scrollbar flex flex-col flex-1 gap-3 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]${activePage !== "personality" ? " hidden" : ""}`}
              >
                <CharacterIdentityPanel
                  bioText={bioText}
                  handleFieldEdit={handleFieldEdit}
                  t={t}
                />
              </div>
              <div
                className={`custom-scrollbar flex flex-col flex-1 gap-3 min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]${activePage !== "style" && activePage !== "examples" ? " hidden" : ""}`}
              >
                <div
                  style={{ display: rightTab === "style" ? undefined : "none" }}
                >
                  <CharacterStylePanel
                    d={d}
                    pendingStyleEntries={pendingStyleEntries}
                    styleEntryDrafts={styleEntryDrafts}
                    handlePendingStyleEntryChange={
                      handlePendingStyleEntryChange
                    }
                    handleAddStyleEntry={handleAddStyleEntry}
                    handleRemoveStyleEntry={handleRemoveStyleEntry}
                    handleStyleEntryDraftChange={handleStyleEntryDraftChange}
                    handleCommitStyleEntry={handleCommitStyleEntry}
                    handleReorderStyleEntries={handleReorderStyleEntries}
                    t={t}
                  />
                </div>
                <div
                  style={{
                    display: rightTab === "examples" ? undefined : "none",
                  }}
                >
                  <CharacterExamplesPanel
                    d={d}
                    normalizedMessageExamples={normalizedMessageExamples}
                    handleFieldEdit={handleFieldEdit}
                    t={t}
                  />
                </div>
              </div>
              <div
                className={`flex flex-col flex-1 min-h-0 overflow-hidden${activePage !== "documents" ? " hidden" : ""}`}
              >
                <DocumentsView inModal />
              </div>
            </div>
          </div>
        )}

        {/* ── Standalone page: character hub */}
        {!sceneOverlay && (
          <CharacterHubView
            d={d}
            bioText={bioText}
            normalizedMessageExamples={normalizedMessageExamples}
            pendingStyleEntries={pendingStyleEntries}
            styleEntryDrafts={styleEntryDrafts}
            handleFieldEdit={handleFieldEdit}
            applyFieldEdit={(field, value) => {
              handleCharacterFieldInput(
                field as keyof CharacterData,
                value as CharacterData[keyof CharacterData],
              );
            }}
            handlePendingStyleEntryChange={handlePendingStyleEntryChange}
            applyStyleEdit={handleCharacterStyleInput}
            handleStyleEntryDraftChange={handleStyleEntryDraftChange}
            characterSaving={characterSaving}
            characterSaveSuccess={characterSaveSuccess}
            characterSaveError={characterSaveError}
            hasPendingChanges={hasPendingChanges}
            onSave={handleSaveCharacter}
          />
        )}
      </div>

      {/* ── Footer (companion overlay only) ────────────────────────── */}
      {sceneOverlay && (
        <div className="flex flex-col gap-2 pt-2 shrink-0 pointer-events-auto">
          {(characterSaveSuccess || combinedSaveError) && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {characterSaveSuccess && (
                <span className="rounded-lg border border-status-success/20 bg-status-success-bg px-3 py-1 text-xs font-bold text-status-success">
                  {characterSaveSuccess}
                </span>
              )}
              {combinedSaveError && (
                <span className="rounded-lg border border-status-danger/20 bg-status-danger-bg px-3 py-1 text-xs font-medium text-status-danger">
                  {combinedSaveError}
                </span>
              )}
            </div>
          )}

          <div className="flex min-h-9 items-center justify-end">
            <input
              type="file"
              id="ce-vrm-upload"
              accept=".vrm"
              className="hidden"
              style={{ display: "none" }}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                if (file) {
                  setState("selectedVrmIndex", 0);
                }
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-9 rounded-xl px-6 text-sm font-bold tracking-[0.05em] transition-[background-color,border-color,color,box-shadow,transform] duration-200 disabled:opacity-50"
              style={accentGradientStyle}
              onClick={() => {
                if (customizing) {
                  setCustomizing(false);
                  setTab("character-select");
                } else {
                  setCustomizing(true);
                  setTab("character");
                }
              }}
            >
              {customizing
                ? t("charactereditor.SelectBtn", { defaultValue: "Select" })
                : t("charactereditor.CustomizeBtn", {
                    defaultValue: "Customize",
                  })}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={pendingNavigation !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <DialogContent className="max-w-md rounded-2xl border-border/60 bg-bg shadow-[var(--shadow-lg)] backdrop-blur-xl">
          <DialogHeader className="gap-3">
            <DialogTitle>
              {t("charactereditor.UnsavedChangesTitle", {
                defaultValue: "Unsaved changes",
              })}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line text-muted-strong">
              {t("charactereditor.UnsavedChangesBody", {
                defaultValue:
                  "You have unsaved changes. Save before switching?",
              })}
              {pendingNavigation?.kind === "character"
                ? `\n${t("charactereditor.SwitchCharacterPrompt", {
                    defaultValue: "Switch to {{name}}?",
                    name: pendingNavigation.entry.name,
                  })}`
                : pendingNavigation?.kind === "page"
                  ? `\n${t("charactereditor.SwitchSectionPrompt", {
                      defaultValue: "Switch to {{name}}?",
                      name:
                        pendingNavigation.page === "personality"
                          ? t("charactereditor.TabPersonality", {
                              defaultValue: "Personality",
                            })
                          : pendingNavigation.page === "style"
                            ? t("charactereditor.TabStyles", {
                                defaultValue: "Style",
                              })
                            : pendingNavigation.page === "examples"
                              ? t("charactereditor.TabExamples", {
                                  defaultValue: "Examples",
                                })
                              : t("nav.documents", {
                                  defaultValue: "Knowledge",
                                }),
                    })}`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              className="border-accent/55 bg-accent/22 text-accent-fg hover:border-accent/75 hover:bg-accent/32"
              onClick={() => void resolvePendingNavigation(true)}
              disabled={characterSaving || voiceSaving}
            >
              {t("common.save", { defaultValue: "Save" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void resolvePendingNavigation(false)}
            >
              {t("charactereditor.DontSave", {
                defaultValue: "Don't save",
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingNavigation(null)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetConfirmOpen}
        onOpenChange={(open: boolean) => {
          if (!open) setResetConfirmOpen(false);
        }}
      >
        <DialogContent className="max-w-md rounded-2xl border-border/60 bg-bg shadow-[var(--shadow-lg)] backdrop-blur-xl">
          <DialogHeader className="gap-3">
            <DialogTitle>
              {t("charactereditor.ResetToDefaults", {
                defaultValue: "Reset to defaults?",
              })}
            </DialogTitle>
            <DialogDescription className="text-muted-strong">
              {t("charactereditor.ResetConfirmBody", {
                defaultValue:
                  "This will discard all unsaved changes and restore this character to its default values.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                handleResetToDefaults();
                setResetConfirmOpen(false);
              }}
            >
              {t("common.reset", { defaultValue: "Reset" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setResetConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Re-export as CharacterView so the upstream App.tsx import resolves here
 * when the Vite alias redirects ./CharacterView to this file.
 */
export { CharacterEditor as CharacterView };

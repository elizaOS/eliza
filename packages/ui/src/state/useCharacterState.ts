/**
 * Character / avatar state, one of the domain hooks AppContext composes.
 *
 * Manages character data, draft editing, VRM avatar selection, and save
 * callbacks. The handleSaveCharacter callback depends on lifecycle state
 * (agentStatus / setAgentStatus), so those are accepted as params rather
 * than coupling this hook to useLifecycleState directly.
 */

import { replaceNameTokens } from "@elizaos/core/protocol";
import { useCallback, useState } from "react";
import { client } from "../api/client";
import type { CharacterData } from "../api/client-types-config";
import type { AgentStatus } from "../api/client-types-core";
import { logger } from "../logger.ts";
import {
  parseArrayInput,
  parseMessageExamplesInput,
  prepareDraftForSave,
} from "./character-draft-helpers";
import {
  loadAvatarIndex,
  loadPersistedActivePackId,
  saveAvatarIndex,
  savePersistedActivePackId,
} from "./persistence";
import { normalizeAvatarIndex } from "./vrm";

// ── Types ──────────────────────────────────────────────────────────────

interface CharacterStateParams {
  agentStatus: AgentStatus | null;
  setAgentStatus: (status: AgentStatus) => void;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useCharacterState({
  agentStatus,
  setAgentStatus,
}: CharacterStateParams) {
  const [characterData, setCharacterData] = useState<CharacterData | null>(
    null,
  );
  const [characterLoading, setCharacterLoading] = useState(false);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [characterSaveSuccess, setCharacterSaveSuccess] = useState<
    string | null
  >(null);
  const [characterSaveError, setCharacterSaveError] = useState<string | null>(
    null,
  );
  const [characterDraft, setCharacterDraft] = useState<CharacterData>({});
  const [selectedVrmIndex, setSelectedVrmIndexRaw] = useState(loadAvatarIndex);
  const [customVrmUrl, setCustomVrmUrl] = useState("");
  const [customVrmPreviewUrl, setCustomVrmPreviewUrl] = useState("");
  const [customBackgroundUrl, setCustomBackgroundUrl] = useState("");
  const [customCatchphrase, setCustomCatchphrase] = useState("");
  const [customVoicePresetId, setCustomVoicePresetId] = useState("");
  const [activePackId, setActivePackIdRaw] = useState<string | null>(() =>
    loadPersistedActivePackId(),
  );
  const [customWorldUrl, setCustomWorldUrl] = useState("");

  const setActivePackId = useCallback((id: string | null) => {
    setActivePackIdRaw(id);
    savePersistedActivePackId(id);
  }, []);

  // Wrap setter to also persist to localStorage and sync to server so
  // headless stream capture uses the same avatar.
  const setSelectedVrmIndex = useCallback((v: number) => {
    const normalized = normalizeAvatarIndex(v);
    setSelectedVrmIndexRaw(normalized);
    saveAvatarIndex(normalized);
    // error-policy:J5 localStorage (saveAvatarIndex, just above) is the source
    // of truth for the avatar; this is a best-effort server mirror so headless
    // stream capture matches. A failed mirror must not block the local change,
    // but it is logged rather than swallowed so a diverging capture is
    // diagnosable.
    client.saveStreamSettings({ avatarIndex: normalized }).catch((err) => {
      logger.warn(
        { err, avatarIndex: normalized },
        "[useCharacterState] failed to mirror avatarIndex to stream settings",
      );
    });
  }, []);

  // ── Callbacks ───────────────────────────────────────────────────────

  const loadCharacter = useCallback(async () => {
    setCharacterLoading(true);
    setCharacterSaveError(null);
    setCharacterSaveSuccess(null);
    try {
      const { character } = await client.getCharacter();
      setCharacterData(character);
      // Replace any un-substituted {{name}} tokens that may have been persisted
      // to the server before the fix (first-run setup saved raw templates).
      const savedName = character.name ?? "";
      const clean = (s: string) => replaceNameTokens(s, savedName);
      setCharacterDraft({
        name: savedName,
        username: character.username ?? "",
        bio: Array.isArray(character.bio)
          ? character.bio.map(clean).join("\n")
          : clean(character.bio ?? ""),
        system: clean(character.system ?? ""),
        adjectives: character.adjectives ?? [],
        topics: character.topics ?? [],
        style: {
          all: character.style?.all ?? [],
          chat: character.style?.chat ?? [],
          post: character.style?.post ?? [],
        },
        messageExamples: character.messageExamples ?? [],
        postExamples: character.postExamples ?? [],
      });
    } catch {
      setCharacterData(null);
      setCharacterDraft({});
    }
    setCharacterLoading(false);
  }, []);

  const handleSaveCharacter = useCallback(async () => {
    setCharacterSaving(true);
    setCharacterSaveError(null);
    setCharacterSaveSuccess(null);
    try {
      // Pass the previously-saved name so save-side tokenization catches
      // stale literals when the user renames in this same save pass.
      const draft = prepareDraftForSave(
        characterDraft,
        characterData?.name ?? undefined,
      );
      if (!(draft.name as string | undefined)?.trim()) {
        throw new Error("Character name is required before saving.");
      }
      const { agentName } = await client.updateCharacter(draft);
      // Also persist avatar selection to config (under "ui" which is allowlisted)
      try {
        await client.updateConfig({
          ui: { avatarIndex: selectedVrmIndex },
        });
      } catch {
        /* non-fatal */
      }
      setCharacterSaveSuccess("Character saved successfully.");
      if (agentName && agentStatus) {
        setAgentStatus({ ...agentStatus, agentName });
      }
      await loadCharacter();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      const finalMessage =
        message === "Character name is required before saving."
          ? message
          : `Failed to save: ${message}`;
      setCharacterSaveError(finalMessage);
      setCharacterSaving(false);
      throw new Error(finalMessage);
    }
    setCharacterSaving(false);
  }, [
    characterData,
    characterDraft,
    agentStatus,
    loadCharacter,
    selectedVrmIndex,
    setAgentStatus,
  ]);

  const handleCharacterFieldInput = useCallback(
    <K extends keyof CharacterData>(field: K, value: CharacterData[K]) => {
      setCharacterDraft((prev: CharacterData) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleCharacterArrayInput = useCallback(
    (field: "adjectives" | "postExamples", value: string) => {
      const items = parseArrayInput(value);
      setCharacterDraft((prev: CharacterData) => ({ ...prev, [field]: items }));
    },
    [],
  );

  const handleCharacterStyleInput = useCallback(
    (subfield: "all" | "chat" | "post", value: string) => {
      const items = parseArrayInput(value);
      setCharacterDraft((prev: CharacterData) => ({
        ...prev,
        style: { ...(prev.style ?? {}), [subfield]: items },
      }));
    },
    [],
  );

  const handleCharacterMessageExamplesInput = useCallback((value: string) => {
    setCharacterDraft((prev: CharacterData) => ({
      ...prev,
      messageExamples: parseMessageExamplesInput(value),
    }));
  }, []);

  return {
    state: {
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
    },
    setCharacterData,
    setCharacterDraft,
    setCharacterSaveSuccess,
    setCharacterSaveError,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomVrmPreviewUrl,
    setCustomBackgroundUrl,
    setCustomCatchphrase,
    setCustomVoicePresetId,
    setActivePackId,
    setCustomWorldUrl,
    loadCharacter,
    handleSaveCharacter,
    handleCharacterFieldInput,
    handleCharacterArrayInput,
    handleCharacterStyleInput,
    handleCharacterMessageExamplesInput,
  };
}

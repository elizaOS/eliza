/**
 * Content-pack lifecycle — load, activate, deactivate, persist, and rehydrate
 * VRM/world/branding bundles. Extracted from AppearanceSettingsSection so the
 * section component can stay presentational.
 *
 * Owns:
 * - `loadedPacks` state with on-unmount release.
 * - The active-pack baseline so deactivate restores prior identity/VRM state.
 * - First-mount rehydration of a persisted pack URL.
 * - The color-scheme cleanup callback that pack activation registers.
 */

import type { ResolvedContentPack } from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyColorScheme,
  applyContentPack,
  loadContentPackFromFiles,
  loadContentPackFromUrl,
  releaseLoadedContentPack,
} from "../content-packs";
import {
  loadPersistedActivePackUrl,
  savePersistedActivePackUrl,
} from "./persistence";
import { useApp } from "./useApp";

function supportsDirectoryUpload(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input") as HTMLInputElement & {
    webkitdirectory?: string | boolean;
  };
  return "webkitdirectory" in input;
}

function isSafeContentPackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export interface UseContentPackResult {
  activePack: ResolvedContentPack | null;
  loadedPacks: ResolvedContentPack[];
  error: string | null;
  setError: (error: string | null) => void;
  canPickDirectory: boolean;
  activate: (pack: ResolvedContentPack) => void;
  deactivate: () => void;
  toggle: (pack: ResolvedContentPack) => void;
  loadFromUrl: (url: string) => Promise<void>;
  loadFromFiles: (files: File[]) => Promise<void>;
  isSafeContentPackUrl: (value: string) => boolean;
}

export function useContentPack(): UseContentPackResult {
  const {
    setState,
    activePackId,
    selectedVrmIndex,
    customVrmUrl,
    customVrmPreviewUrl,
    customBackgroundUrl,
    customWorldUrl,
    onboardingName,
    onboardingStyle,
  } = useApp();

  const [loadedPacks, setLoadedPacks] = useState<ResolvedContentPack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const colorSchemeCleanupRef = useRef<(() => void) | null>(null);
  const loadedPacksRef = useRef<ResolvedContentPack[]>([]);
  const baselineRef = useRef<{
    selectedVrmIndex: number;
    customVrmUrl: string;
    customVrmPreviewUrl: string;
    customBackgroundUrl: string;
    customWorldUrl: string;
    onboardingName: string;
    onboardingStyle: string;
  } | null>(null);
  const rehydratedRef = useRef(false);
  const canPickDirectory = useMemo(() => supportsDirectoryUpload(), []);

  useEffect(() => {
    loadedPacksRef.current = loadedPacks;
  }, [loadedPacks]);

  useEffect(() => {
    return () => {
      for (const pack of loadedPacksRef.current) {
        releaseLoadedContentPack(pack);
      }
    };
  }, []);

  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;

    if (!activePackId) return;

    const persistedUrl = loadPersistedActivePackUrl();
    if (!persistedUrl || !isSafeContentPackUrl(persistedUrl)) {
      if (persistedUrl) savePersistedActivePackUrl(null);
      return;
    }

    let cancelled = false;
    void loadContentPackFromUrl(persistedUrl)
      .then((pack) => {
        if (cancelled) return;
        setLoadedPacks((prev) => {
          if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
          return [...prev, pack];
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(
          "[eliza][content-packs] Failed to restore persisted pack:",
          err,
        );
        savePersistedActivePackUrl(null);
        setState("activePackId", null);
      });

    return () => {
      cancelled = true;
    };
  }, [activePackId, setState]);

  const activate = useCallback(
    (pack: ResolvedContentPack) => {
      if (baselineRef.current == null) {
        baselineRef.current = {
          selectedVrmIndex,
          customVrmUrl,
          customVrmPreviewUrl,
          customBackgroundUrl,
          customWorldUrl,
          onboardingName,
          onboardingStyle,
        };
      }

      setState("activePackId", pack.manifest.id);
      savePersistedActivePackUrl(
        pack.source.kind === "url" ? pack.source.url : null,
      );
      applyContentPack(pack, {
        setCustomVrmUrl: (url) => setState("customVrmUrl", url),
        setCustomVrmPreviewUrl: (url) => setState("customVrmPreviewUrl", url),
        setCustomBackgroundUrl: (url) => setState("customBackgroundUrl", url),
        setCustomWorldUrl: (url) => setState("customWorldUrl", url),
        setSelectedVrmIndex: (idx) => setState("selectedVrmIndex", idx),
        setOnboardingName: (name) => setState("onboardingName", name),
        setOnboardingStyle: (style) => setState("onboardingStyle", style),
        setCustomCatchphrase: (phrase) => setState("customCatchphrase", phrase),
        setCustomVoicePresetId: (id) => setState("customVoicePresetId", id),
      });
      colorSchemeCleanupRef.current?.();
      colorSchemeCleanupRef.current = applyColorScheme(pack.colorScheme);
      setError(null);
    },
    [
      customBackgroundUrl,
      customVrmUrl,
      customVrmPreviewUrl,
      customWorldUrl,
      onboardingName,
      onboardingStyle,
      selectedVrmIndex,
      setState,
    ],
  );

  const deactivate = useCallback(() => {
    const activePack = activePackId
      ? (loadedPacksRef.current.find((p) => p.manifest.id === activePackId) ??
        null)
      : null;

    if (activePack?.source.kind === "file") {
      releaseLoadedContentPack(activePack);
      setLoadedPacks((prev) =>
        prev.filter((p) => p.manifest.id !== activePack.manifest.id),
      );
    }

    setState("activePackId", null);
    savePersistedActivePackUrl(null);
    colorSchemeCleanupRef.current?.();
    colorSchemeCleanupRef.current = null;

    const baseline = baselineRef.current;
    if (baseline) {
      setState("selectedVrmIndex", baseline.selectedVrmIndex);
      setState("customVrmUrl", baseline.customVrmUrl);
      setState("customVrmPreviewUrl", baseline.customVrmPreviewUrl);
      setState("customBackgroundUrl", baseline.customBackgroundUrl);
      setState("customWorldUrl", baseline.customWorldUrl);
      setState("onboardingName", baseline.onboardingName);
      setState("onboardingStyle", baseline.onboardingStyle);
      baselineRef.current = null;
    }
    setError(null);
  }, [activePackId, setState]);

  const toggle = useCallback(
    (pack: ResolvedContentPack) => {
      if (activePackId === pack.manifest.id) {
        deactivate();
      } else {
        activate(pack);
      }
    },
    [activePackId, activate, deactivate],
  );

  const loadFromUrl = useCallback(
    async (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      if (!isSafeContentPackUrl(trimmed)) {
        setError("Pack URL must be an http(s) URL");
        return;
      }

      try {
        const pack = await loadContentPackFromUrl(trimmed);
        setLoadedPacks((prev) => {
          if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
          return [...prev, pack];
        });
        activate(pack);
      } catch (err) {
        setError(
          `Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [activate],
  );

  const loadFromFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const pack = await loadContentPackFromFiles(files);
        setLoadedPacks((prev) => {
          if (prev.some((p) => p.manifest.id === pack.manifest.id)) {
            releaseLoadedContentPack(pack);
            return prev;
          }
          return [...prev, pack];
        });
        activate(pack);
      } catch (err) {
        setError(
          `Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [activate],
  );

  const activePack = useMemo(
    () =>
      activePackId
        ? (loadedPacks.find((p) => p.manifest.id === activePackId) ?? null)
        : null,
    [activePackId, loadedPacks],
  );

  return {
    activePack,
    loadedPacks,
    error,
    setError,
    canPickDirectory,
    activate,
    deactivate,
    toggle,
    loadFromUrl,
    loadFromFiles,
    isSafeContentPackUrl,
  };
}

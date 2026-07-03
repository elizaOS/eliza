/**
 * ModelTesterView — the single GUI/XR/TUI data wrapper for the Model Tester
 * surface.
 *
 * It owns the live probe data (status fetch, per-probe run dispatch, run-all,
 * prompt presets, image/audio asset pickers) and renders the one presentational
 * {@link ModelTesterSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The
 * TUI surface renders the same `ModelTesterSpatialView` through the terminal
 * registry (see `register-terminal-view.tsx`).
 *
 * The spatial vocabulary has no `<input type="file">`; the asset-pick action
 * signals (`pick-image` / `pick-audio`) drive a real hidden file input created
 * programmatically here, so the GUI keeps a true file-pick affordance while the
 * presentational view stays modality-portable.
 */

import type { OverlayAppContext } from "@elizaos/ui/components/apps/overlay-app-api";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ModelTesterProbeId,
  type ModelTesterProbeRow,
  type ModelTesterSnapshot,
  ModelTesterSpatialView,
} from "./components/ModelTesterSpatialView.tsx";
import {
  type AudioPayload,
  audioFileToPayload,
  fileToDataUrl,
} from "./model-tester-probe.helpers.ts";

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

const PROMPT_BY_PRESET: Record<string, string> = {
  smoke: DEFAULT_PROMPT,
  vision: "Describe the attached image in one compact sentence.",
  voice: "Say a short warm audio check for the model tester.",
};

/** Probe display order + registered model type, mirroring the route handler. */
const PROBE_DEFS: ReadonlyArray<{
  id: ModelTesterProbeId;
  label: string;
  modelType: string | null;
}> = [
  { id: "text-small", label: "Text", modelType: "TEXT_SMALL" },
  { id: "text-large", label: "Stream", modelType: "TEXT_LARGE" },
  { id: "embedding", label: "Embedding", modelType: "TEXT_EMBEDDING" },
  { id: "text-to-speech", label: "Voice", modelType: "TEXT_TO_SPEECH" },
  { id: "transcription", label: "Transcription", modelType: "TRANSCRIPTION" },
  { id: "vad", label: "Activity", modelType: null },
  { id: "image-description", label: "Vision", modelType: "IMAGE_DESCRIPTION" },
  { id: "image", label: "Image", modelType: "IMAGE" },
];

const PROBE_ORDER: ModelTesterProbeId[] = PROBE_DEFS.map((def) => def.id);

interface StatusEntry {
  id: string;
  modelType?: string;
  available?: boolean;
}

interface RunResult {
  ok: boolean;
  test: ModelTesterProbeId;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** Resolve the TTS probe's base64 audio output to a playable data URL. */
function audioSrcOf(result: RunResult | undefined): string | undefined {
  const output = result?.output;
  if (!output || typeof output !== "object") return undefined;
  const base64 = (output as { base64?: unknown }).base64;
  if (typeof base64 !== "string") return undefined;
  const contentType = (output as { contentType?: unknown }).contentType;
  return `data:${typeof contentType === "string" ? contentType : "audio/wav"};base64,${base64}`;
}

/** Resolve the image probe's generated image urls. */
function imageUrlsOf(result: RunResult | undefined): string[] {
  const images = (result?.output as { images?: unknown } | undefined)?.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((image) =>
      image && typeof image === "object"
        ? (image as { url?: unknown }).url
        : null,
    )
    .filter((url): url is string => typeof url === "string" && url.length > 0);
}

/** Open a one-shot hidden file picker and resolve with the chosen File. */
function pickFile(accept: string): Promise<File | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => {
      finish(input.files?.[0] ?? null);
    });
    // A cancelled picker fires no `change`; resolve null on the next focus.
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

export function ModelTesterView({
  exitToApps,
}: Partial<Pick<OverlayAppContext, "exitToApps">> = {}) {
  const [statuses, setStatuses] = useState<StatusEntry[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [results, setResults] = useState<
    Partial<Record<ModelTesterProbeId, RunResult>>
  >({});
  const [running, setRunning] = useState<
    Partial<Record<ModelTesterProbeId, boolean>>
  >({});
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [audioPayload, setAudioPayload] = useState<AudioPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );

  const refreshStatus = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/model-tester/status");
      const json = (await res.json()) as { tests?: StatusEntry[] };
      setStatuses(json.tests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void refreshStatus();
  }, [refreshStatus]);

  const runTest = useCallback(
    async (test: ModelTesterProbeId) => {
      setRunning((prev) => ({ ...prev, [test]: true }));
      setResults((prev) => ({ ...prev, [test]: undefined }));
      try {
        const res = await fetch("/api/model-tester/run", {
          method: "POST",
          headers: { "content-type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            test,
            prompt,
            imageDataUrl,
            audioDataUrl: audioPayload?.audioDataUrl,
            pcmSamples: audioPayload?.pcmSamples,
            sampleRateHz: audioPayload?.sampleRateHz,
          }),
        });
        const json = (await res.json()) as RunResult;
        setResults((prev) => ({ ...prev, [test]: json }));
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [test]: {
            ok: false,
            test,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setRunning((prev) => ({ ...prev, [test]: false }));
      }
    },
    [audioPayload, imageDataUrl, prompt],
  );

  const runAll = useCallback(async () => {
    for (const test of PROBE_ORDER) {
      await runTest(test);
    }
  }, [runTest]);

  const pickImage = useCallback(async () => {
    const file = await pickFile("image/*");
    if (!file) return;
    setError(null);
    setImageDataUrl(await fileToDataUrl(file));
  }, []);

  const pickAudio = useCallback(async () => {
    const file = await pickFile("audio/*");
    if (!file) return;
    setError(null);
    try {
      setAudioPayload(await audioFileToPayload(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const navigateBack = useCallback(() => {
    if (exitToApps) {
      exitToApps();
      return;
    }
    if (typeof window === "undefined") return;
    dispatchNavigateViewEvent({ viewId: "apps", viewPath: "/apps" });
  }, [exitToApps]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("run:")) {
        void runTest(action.slice("run:".length) as ModelTesterProbeId);
        return;
      }
      if (action.startsWith("preset:")) {
        const preset = action.slice("preset:".length);
        const next = PROMPT_BY_PRESET[preset];
        if (next) setPrompt(next);
        return;
      }
      switch (action) {
        case "refresh-status":
          void refreshStatus();
          return;
        case "run-all":
          void runAll();
          return;
        case "pick-image":
          void pickImage();
          return;
        case "pick-audio":
          void pickAudio();
          return;
        case "back":
          navigateBack();
          return;
      }
    },
    [navigateBack, pickAudio, pickImage, refreshStatus, runAll, runTest],
  );

  const probes: ModelTesterProbeRow[] = PROBE_DEFS.map((def) => {
    const status = statusById.get(def.id);
    const result = results[def.id];
    return {
      id: def.id,
      label: def.label,
      modelType: status?.modelType ?? def.modelType,
      available: status?.available ?? def.id === "vad",
      running: running[def.id] === true,
      result: result
        ? {
            ok: result.ok,
            durationMs: result.durationMs,
            output: outputText(result.ok ? result.output : result.error),
            audioSrc:
              def.id === "text-to-speech" ? audioSrcOf(result) : undefined,
            imageUrls: def.id === "image" ? imageUrlsOf(result) : undefined,
          }
        : undefined,
    };
  });

  const snapshot: ModelTesterSnapshot = {
    prompt,
    probes,
    readyCount: probes.filter((probe) => probe.available).length,
    runningCount: probes.filter((probe) => probe.running).length,
    completeCount: probes.filter((probe) => probe.result).length,
    imageDataUrl,
    audioLoaded: audioPayload !== null,
    error,
  };

  return <ModelTesterSpatialView snapshot={snapshot} onAction={onAction} />;
}

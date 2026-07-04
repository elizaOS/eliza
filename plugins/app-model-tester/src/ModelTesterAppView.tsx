/**
 * Overlay React view for the Model Tester: fetches per-probe status, dispatches
 * individual and run-all probe requests against `/api/model-tester/*`, and renders
 * results (text, embedding preview, generated images, TTS audio) with image/audio
 * asset pickers and prompt presets. Each control is wired to the agent-surface
 * registry so an Eliza agent can address it.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { OverlayAppContext } from "@elizaos/ui/components/apps/overlay-app-api";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import { Spinner } from "@elizaos/ui/components/ui/spinner";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  FileAudio,
  Headphones,
  Image as ImageIcon,
  ImagePlus,
  type LucideIcon,
  MessageSquareText,
  Mic,
  Play,
  RefreshCw,
  Sparkles,
  Volume2,
  Waves,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AudioPayload,
  audioFileToPayload,
  fileToDataUrl,
} from "./model-tester-probe.helpers";

type TestId =
  | "text-small"
  | "text-large"
  | "embedding"
  | "image"
  | "image-description"
  | "transcription"
  | "text-to-speech"
  | "vad";

interface TestStatus {
  id: TestId;
  label: string;
  modelType: string;
  available: boolean;
}

interface TestResult {
  ok: boolean;
  test: TestId;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

const PROMPT_PRESETS = [
  {
    id: "smoke",
    label: "Smoke",
    prompt: DEFAULT_PROMPT,
  },
  {
    id: "vision",
    label: "Vision",
    prompt: "Describe the attached image in one compact sentence.",
  },
  {
    id: "voice",
    label: "Voice",
    prompt: "Say a short warm audio check for the model tester.",
  },
] as const;

const TEST_ORDER: TestId[] = [
  "text-small",
  "text-large",
  "embedding",
  "text-to-speech",
  "transcription",
  "vad",
  "image-description",
  "image",
];

const TEST_COPY: Record<
  TestId,
  { title: string; subtitle: string; Icon: LucideIcon }
> = {
  "text-small": {
    title: "Text",
    subtitle: "TEXT_SMALL",
    Icon: MessageSquareText,
  },
  "text-large": {
    title: "Stream",
    subtitle: "TEXT_LARGE",
    Icon: Waves,
  },
  embedding: {
    title: "Embedding",
    subtitle: "Vector",
    Icon: Cpu,
  },
  "text-to-speech": {
    title: "Voice",
    subtitle: "TTS",
    Icon: Volume2,
  },
  transcription: {
    title: "Transcription",
    subtitle: "Audio",
    Icon: Mic,
  },
  vad: {
    title: "Activity",
    subtitle: "VAD",
    Icon: Activity,
  },
  "image-description": {
    title: "Vision",
    subtitle: "Describe",
    Icon: ImageIcon,
  },
  image: {
    title: "Image",
    subtitle: "Generate",
    Icon: ImagePlus,
  },
};

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function audioSrc(result: TestResult | undefined): string | null {
  const output = result?.output;
  if (!output || typeof output !== "object") return null;
  const base64 = (output as { base64?: unknown }).base64;
  if (typeof base64 !== "string") return null;
  const contentType = (output as { contentType?: unknown }).contentType;
  return `data:${typeof contentType === "string" ? contentType : "audio/wav"};base64,${base64}`;
}

function generatedImageUrls(result: TestResult | undefined): string[] {
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

export function ModelTesterAppView({ exitToApps, t }: OverlayAppContext) {
  const [statuses, setStatuses] = useState<TestStatus[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [results, setResults] = useState<Partial<Record<TestId, TestResult>>>(
    {},
  );
  const [running, setRunning] = useState<Partial<Record<TestId, boolean>>>({});
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [audioPayload, setAudioPayload] = useState<AudioPayload | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const readyCount = TEST_ORDER.filter(
    (id) => statusById.get(id)?.available ?? id === "vad",
  ).length;
  const runningCount = Object.values(running).filter(Boolean).length;
  const completeCount = Object.values(results).filter(Boolean).length;

  const backControl = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back to apps",
    group: "header",
    description: "Close the model tester and return to the apps grid",
  });
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "action-refresh-status",
    role: "button",
    label: "Refresh model status",
    group: "header",
    description: "Reload the availability status of each model probe",
  });
  const runAllControl = useAgentElement<HTMLButtonElement>({
    id: "action-run-all",
    role: "button",
    label: "Run all",
    group: "header",
    description: "Run every model probe in sequence",
  });
  const imageInputControl = useAgentElement<HTMLInputElement>({
    id: "input-image-asset",
    role: "button",
    label: "Choose image",
    group: "assets",
    description:
      "Open the file picker to select an image for image-description probes",
    status: imageDataUrl ? "loaded" : undefined,
  });
  const audioInputControl = useAgentElement<HTMLInputElement>({
    id: "input-audio-asset",
    role: "button",
    label: "Choose audio",
    group: "assets",
    description:
      "Open the file picker to select an audio file for transcription and voice-activity probes",
    status: audioPayload ? "loaded" : undefined,
  });

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/model-tester/status");
    const json = (await res.json()) as { tests?: TestStatus[] };
    setStatuses(json.tests ?? []);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runTest = useCallback(
    async (test: TestId) => {
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
        const json = (await res.json()) as TestResult;
        setResults((prev) => ({ ...prev, [test]: json }));
      } catch (error) {
        setResults((prev) => ({
          ...prev,
          [test]: {
            ok: false,
            test,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      } finally {
        setRunning((prev) => ({ ...prev, [test]: false }));
      }
    },
    [audioPayload, imageDataUrl, prompt],
  );

  const runAll = useCallback(async () => {
    for (const test of TEST_ORDER) {
      await runTest(test);
    }
  }, [runTest]);

  const handleImage = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setAssetError(null);
    setImageDataUrl(await fileToDataUrl(file));
  }, []);

  const handleAudio = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setAssetError(null);
    try {
      setAudioPayload(await audioFileToPayload(file));
    } catch (error) {
      setAssetError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return (
    <div
      data-testid="model-tester-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={backControl.ref}
            {...backControl.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              Model Tester
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            ref={refreshControl.ref}
            {...refreshControl.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted hover:text-txt"
            onClick={refreshStatus}
            aria-label="Refresh model status"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            ref={runAllControl.ref}
            {...runAllControl.agentProps}
            size="sm"
            onClick={runAll}
          >
            <Play className="mr-2 h-4 w-4" />
            Run all
          </Button>
        </div>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-3 pb-32 pt-2 sm:px-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-3">
          <section className="py-2">
            <div className="grid grid-cols-3 gap-2">
              <MetricBadge
                icon={CheckCircle2}
                value={`${readyCount}/${TEST_ORDER.length}`}
                tone="ok"
                label="Ready probes"
              />
              <MetricBadge
                icon={Play}
                value={String(runningCount)}
                tone={runningCount > 0 ? "accent" : "muted"}
                label="Running probes"
              />
              <MetricBadge
                icon={Sparkles}
                value={String(completeCount)}
                tone="muted"
                label="Completed probes"
              />
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {PROMPT_PRESETS.map((preset) => (
                <Button
                  unstyled
                  key={preset.id}
                  type="button"
                  onClick={() => setPrompt(preset.prompt)}
                  aria-pressed={prompt === preset.prompt}
                  className={`h-10 px-2 text-left text-xs font-semibold transition ${
                    prompt === preset.prompt
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-bg-accent hover:text-txt"
                  }`}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label
                htmlFor="model-tester-image-file"
                className="flex min-h-10 cursor-pointer items-center justify-center gap-2 px-2 py-1.5 text-sm text-txt hover:bg-bg-accent/50"
              >
                <ImageIcon
                  className={`h-4 w-4 ${imageDataUrl ? "text-ok" : "text-muted"}`}
                />
                <span className="min-w-0 truncate">Image</span>
                <Input
                  id="model-tester-image-file"
                  ref={imageInputControl.ref}
                  {...imageInputControl.agentProps}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) =>
                    void handleImage(event.target.files?.[0])
                  }
                />
              </label>
              <label
                htmlFor="model-tester-audio-file"
                className="flex min-h-10 cursor-pointer items-center justify-center gap-2 px-2 py-1.5 text-sm text-txt hover:bg-bg-accent/50"
              >
                <FileAudio
                  className={`h-4 w-4 ${audioPayload ? "text-ok" : "text-muted"}`}
                />
                <span className="min-w-0 truncate">Audio</span>
                <Input
                  id="model-tester-audio-file"
                  ref={audioInputControl.ref}
                  {...audioInputControl.agentProps}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(event) =>
                    void handleAudio(event.target.files?.[0])
                  }
                />
              </label>
            </div>
            {assetError ? (
              <div className="mt-3 text-xs leading-relaxed text-danger">
                {assetError}
              </div>
            ) : null}
            {imageDataUrl ? (
              <img
                src={imageDataUrl}
                alt=""
                className="mt-3 aspect-video w-full object-cover"
              />
            ) : null}
          </section>

          <main className="flex flex-col gap-1">
            {TEST_ORDER.map((id) => {
              const copy = TEST_COPY[id];
              const Icon = copy.Icon;
              const status = statusById.get(id);
              const result = results[id];
              const isRunning = running[id] === true;
              const audio = id === "text-to-speech" ? audioSrc(result) : null;
              const urls = id === "image" ? generatedImageUrls(result) : [];
              return (
                <section key={id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center">
                        <Icon className="h-5 w-5 text-txt" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold text-txt">
                          {copy.title}
                        </h2>
                        <div className="mt-0.5 truncate font-mono text-2xs text-muted">
                          {status?.modelType ?? copy.subtitle}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill
                        ready={status?.available ?? id === "vad"}
                        running={isRunning}
                        failed={result ? !result.ok : false}
                      />
                      <TestRunButton
                        id={id}
                        title={copy.title}
                        isRunning={isRunning}
                        onRun={() => void runTest(id)}
                      />
                    </div>
                  </div>

                  {result ? (
                    <div className="mt-4">
                      <span
                        className={`text-xs font-semibold ${
                          result.ok ? "text-muted" : "text-danger"
                        }`}
                      >
                        {result.ok ? `${result.durationMs ?? 0}ms` : "Failed"}
                      </span>
                      {audio ? (
                        // biome-ignore lint/a11y/useMediaCaption: This is generated TTS output, not source media with available captions.
                        <audio controls src={audio} className="mt-3 w-full" />
                      ) : null}
                      {urls.map((url) => (
                        <img
                          key={url}
                          src={url}
                          alt=""
                          className="mt-3 aspect-square w-full object-cover"
                        />
                      ))}
                      <pre className="mt-3 max-h-60 overflow-auto bg-bg/60 p-3 text-xs leading-relaxed text-muted">
                        {outputText(result.ok ? result.output : result.error)}
                      </pre>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </main>
        </div>
      </div>
    </div>
  );
}

function TestRunButton({
  id,
  title,
  isRunning,
  onRun,
}: {
  id: TestId;
  title: string;
  isRunning: boolean;
  onRun: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `action-run-${id}`,
    role: "button",
    label: `Run ${title}`,
    group: "probes",
    description: `Run the ${title} model probe`,
    status: isRunning ? "running" : undefined,
  });
  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="outline"
      size="icon"
      className="h-9 w-9"
      disabled={isRunning}
      onClick={onRun}
      aria-label={`Run ${title}`}
    >
      {isRunning ? (
        <Spinner className="h-4 w-4" />
      ) : id === "text-to-speech" ? (
        <Headphones className="h-4 w-4" />
      ) : id === "transcription" || id === "vad" ? (
        <Mic className="h-4 w-4" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
    </Button>
  );
}

function StatusPill({
  ready,
  running,
  failed,
}: {
  ready: boolean;
  running: boolean;
  failed: boolean;
}) {
  const { color, state } = running
    ? { color: "bg-accent", state: "Running" }
    : failed
      ? { color: "bg-danger", state: "Failed" }
      : ready
        ? { color: "bg-ok", state: "Ready" }
        : { color: "bg-muted", state: "Missing" };
  return (
    <span
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center"
      role="status"
      aria-label={state}
      title={state}
    >
      <span className={`h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

function MetricBadge({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  tone: "ok" | "accent" | "muted";
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "accent"
        ? "text-accent"
        : "text-muted";
  return (
    <div
      className="flex min-h-12 items-center justify-center gap-2 px-2"
      role="status"
      aria-label={label}
      title={label}
    >
      <Icon className={`h-4 w-4 ${toneClass}`} />
      <span className="text-sm font-semibold text-txt">{value}</span>
    </div>
  );
}

import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, Spinner } from "@elizaos/app-core";
import {
  ArrowLeft,
  FileAudio,
  Image as ImageIcon,
  Mic,
  Play,
  RefreshCw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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

interface AudioPayload {
  audioDataUrl: string;
  pcmSamples: number[];
  sampleRateHz: number;
}

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

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

const TEST_COPY: Record<TestId, { title: string; subtitle: string }> = {
  "text-small": {
    title: "Text",
    subtitle: "Non-streaming TEXT_SMALL probe",
  },
  "text-large": {
    title: "Streaming Text",
    subtitle: "TEXT_LARGE with chunk capture",
  },
  embedding: {
    title: "Embedding",
    subtitle: "Vector dimensions and preview",
  },
  "text-to-speech": {
    title: "Voice",
    subtitle: "Generate playable speech",
  },
  transcription: {
    title: "Transcription",
    subtitle: "Transcribe selected audio",
  },
  vad: {
    title: "Voice Activity",
    subtitle: "Detect active regions in selected audio",
  },
  "image-description": {
    title: "Image Description",
    subtitle: "Describe selected image",
  },
  image: {
    title: "Image Generation",
    subtitle: "Generate one image from the prompt",
  },
};

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function audioFileToPayload(file: File): Promise<AudioPayload> {
  const audioDataUrl = await fileToDataUrl(file);
  const buffer = await file.arrayBuffer();
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("This browser cannot decode audio files.");
  }
  const context = new AudioContextCtor();
  const decoded = await context.decodeAudioData(buffer.slice(0));
  const src = decoded.getChannelData(0);
  const targetRate = 16_000;
  const maxSamples = targetRate * 15;
  const ratio = decoded.sampleRate / targetRate;
  const length = Math.min(maxSamples, Math.floor(src.length / ratio));
  const pcmSamples = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    pcmSamples[i] = src[Math.min(src.length - 1, Math.floor(i * ratio))] ?? 0;
  }
  await context.close();
  return { audioDataUrl, pcmSamples, sampleRateHz: targetRate };
}

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
          headers: { "content-type": "application/json" },
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
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-lg text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              Model Tester
            </h1>
            <p className="truncate text-xs-tight text-muted">
              End-to-end Eliza-1 probes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-muted hover:text-txt"
            onClick={refreshStatus}
            aria-label="Refresh model status"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={runAll}>
            <Play className="mr-2 h-4 w-4" />
            Run all
          </Button>
        </div>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
          <aside className="space-y-4">
            <section className="rounded-lg border border-border/20 bg-bg-accent/60 p-4">
              <label
                htmlFor="model-tester-prompt"
                className="text-xs font-semibold uppercase tracking-normal text-muted"
              >
                Prompt
              </label>
              <textarea
                id="model-tester-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={5}
                className="mt-2 w-full resize-none rounded-lg border border-border/30 bg-bg px-3 py-2 text-sm text-txt outline-none focus:border-border"
              />
            </section>

            <section className="rounded-lg border border-border/20 bg-bg-accent/60 p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-normal text-muted">
                Assets
              </div>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/24 bg-bg px-3 py-3 text-sm text-txt hover:bg-bg-accent">
                <ImageIcon className="h-4 w-4 text-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {imageDataUrl ? "Image loaded" : "Choose image"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) =>
                    void handleImage(event.target.files?.[0])
                  }
                />
              </label>
              <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-lg border border-border/24 bg-bg px-3 py-3 text-sm text-txt hover:bg-bg-accent">
                <FileAudio className="h-4 w-4 text-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {audioPayload ? "Audio loaded" : "Choose audio"}
                </span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(event) =>
                    void handleAudio(event.target.files?.[0])
                  }
                />
              </label>
              {assetError ? (
                <p className="mt-3 text-xs leading-relaxed text-danger">
                  {assetError}
                </p>
              ) : null}
              {imageDataUrl ? (
                <img
                  src={imageDataUrl}
                  alt=""
                  className="mt-3 aspect-video w-full rounded-lg object-cover"
                />
              ) : null}
            </section>
          </aside>

          <main className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {TEST_ORDER.map((id) => {
              const copy = TEST_COPY[id];
              const status = statusById.get(id);
              const result = results[id];
              const isRunning = running[id] === true;
              const audio = id === "text-to-speech" ? audioSrc(result) : null;
              const urls = id === "image" ? generatedImageUrls(result) : [];
              return (
                <section
                  key={id}
                  className="min-h-64 rounded-lg border border-border/20 bg-bg-accent/60 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-txt">
                        {copy.title}
                      </h2>
                      <p className="mt-1 text-xs text-muted">{copy.subtitle}</p>
                      <p className="mt-2 font-mono text-2xs text-muted">
                        {status?.modelType ?? id}
                      </p>
                    </div>
                    <StatusPill ready={status?.available ?? id === "vad"} />
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    disabled={isRunning}
                    onClick={() => void runTest(id)}
                  >
                    {isRunning ? (
                      <Spinner className="mr-2 h-4 w-4" />
                    ) : id === "text-to-speech" ? (
                      <Volume2 className="mr-2 h-4 w-4" />
                    ) : id === "transcription" || id === "vad" ? (
                      <Mic className="mr-2 h-4 w-4" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    Run
                  </Button>

                  {result ? (
                    <div className="mt-4">
                      <div
                        className={`text-xs font-semibold ${
                          result.ok ? "text-ok" : "text-danger"
                        }`}
                      >
                        {result.ok
                          ? `Passed in ${result.durationMs ?? 0}ms`
                          : "Failed"}
                      </div>
                      {audio ? (
                        // biome-ignore lint/a11y/useMediaCaption: This is generated TTS output, not source media with available captions.
                        <audio controls src={audio} className="mt-3 w-full" />
                      ) : null}
                      {urls.map((url) => (
                        <img
                          key={url}
                          src={url}
                          alt=""
                          className="mt-3 aspect-square w-full rounded-lg object-cover"
                        />
                      ))}
                      <pre className="mt-3 max-h-60 overflow-auto rounded-lg border border-border/20 bg-bg p-3 text-xs leading-relaxed text-muted">
                        {outputText(result.ok ? result.output : result.error)}
                      </pre>
                    </div>
                  ) : (
                    <div className="mt-4 flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border/25 text-xs text-muted">
                      No output yet.
                    </div>
                  )}
                </section>
              );
            })}
          </main>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs-tight font-semibold ${
        ready
          ? "border-ok/35 bg-ok/12 text-ok"
          : "border-border bg-bg text-muted"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-ok" : "bg-muted"}`}
      />
      {ready ? "Ready" : "Missing"}
    </span>
  );
}

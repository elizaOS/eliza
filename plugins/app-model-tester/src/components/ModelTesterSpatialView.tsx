/**
 * ModelTesterSpatialView - the model-tester dashboard authored with the
 * spatial vocabulary and mounted in `<SpatialSurface>` for the GUI surface.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives (no browser/Capacitor
 * runtime import). It mirrors the same probe data as the rich
 * `ModelTesterAppView` React view.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  Image,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

export type ModelTesterProbeId =
  | "text-small"
  | "text-large"
  | "embedding"
  | "image"
  | "image-description"
  | "transcription"
  | "text-to-speech"
  | "vad";

export interface ModelTesterProbeRow {
  id: ModelTesterProbeId;
  /** Display title, e.g. "Text", "Voice". */
  label: string;
  /** Registered model type, e.g. "TEXT_SMALL"; null when none (vad). */
  modelType: string | null;
  /** Whether a provider is registered for this probe. */
  available: boolean;
  /** True while this probe is mid-flight. */
  running: boolean;
  /** Set once a run has completed (ok or error). */
  result?: {
    ok: boolean;
    durationMs?: number;
    /** Pre-formatted text output / error to show in the `<pre>` body. */
    output?: string;
    /** Resolved audio src for the text-to-speech probe. */
    audioSrc?: string;
    /** Resolved generated-image urls for the image probe. */
    imageUrls?: string[];
  };
}

export interface ModelTesterSnapshot {
  /** Active prompt text. */
  prompt: string;
  /** All 8 probes in display order. */
  probes: ModelTesterProbeRow[];
  /** Number of probes with a registered provider. */
  readyCount: number;
  /** Number of probes currently running. */
  runningCount: number;
  /** Number of probes with a completed result. */
  completeCount: number;
  /** Data URL of the uploaded image asset, if any. */
  imageDataUrl?: string | null;
  /** Whether an audio asset has been loaded for transcription / vad. */
  audioLoaded?: boolean;
  /** Surfaced asset-decode error, if any. */
  error?: string | null;
}

const PROMPT_PRESETS = ["Smoke", "Vision", "Voice"] as const;

function probeTone(probe: ModelTesterProbeRow): SpatialTone {
  if (probe.running) return "primary";
  if (probe.result) return probe.result.ok ? "success" : "danger";
  return probe.available ? "default" : "muted";
}

function probeMark(probe: ModelTesterProbeRow): string {
  if (probe.running) return "~";
  if (probe.result) return probe.result.ok ? "+" : "x";
  return probe.available ? "." : "-";
}

function resultLabel(probe: ModelTesterProbeRow): string {
  if (probe.running) return "running";
  if (!probe.result) return "idle";
  if (!probe.result.ok) return "failed";
  return `${probe.result.durationMs ?? 0}ms`;
}

export interface ModelTesterSpatialViewProps {
  snapshot: ModelTesterSnapshot;
  /** Dispatch by agent id: `back`, `refresh-status`, `run-all`, `run:<probeId>`, `preset:<name>`, `pick-image`, `pick-audio`. */
  onAction?: (action: string) => void;
}

export function ModelTesterSpatialView({
  snapshot,
  onAction,
}: ModelTesterSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone="success">
          {snapshot.readyCount} ready
        </Text>
        <Text
          style="caption"
          tone={snapshot.runningCount > 0 ? "primary" : "muted"}
        >
          {snapshot.runningCount} running
        </Text>
        <Text style="caption" tone="muted" grow={1}>
          {snapshot.completeCount} done
        </Text>
        <Button agent="refresh-status" onPress={dispatch("refresh-status")}>
          Refresh
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="back"
          onPress={dispatch("back")}
        >
          Back
        </Button>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="prompt" />
      <Text style="caption" tone="muted" wrap>
        {snapshot.prompt || " "}
      </Text>
      <HStack gap={1} wrap>
        {PROMPT_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant="outline"
            tone="default"
            grow={1}
            agent={`preset-${preset.toLowerCase()}`}
            onPress={dispatch(`preset:${preset.toLowerCase()}`)}
          >
            {preset}
          </Button>
        ))}
      </HStack>
      <HStack gap={1} wrap>
        <Button
          variant="outline"
          tone={snapshot.imageDataUrl ? "success" : "default"}
          grow={1}
          agent="pick-image"
          onPress={dispatch("pick-image")}
        >
          {snapshot.imageDataUrl ? "Image ok" : "Image"}
        </Button>
        <Button
          variant="outline"
          tone={snapshot.audioLoaded ? "success" : "default"}
          grow={1}
          agent="pick-audio"
          onPress={dispatch("pick-audio")}
        >
          {snapshot.audioLoaded ? "Audio ok" : "Audio"}
        </Button>
        <Button grow={1} agent="run-all" onPress={dispatch("run-all")}>
          Run all
        </Button>
      </HStack>
      {snapshot.imageDataUrl ? (
        <Image src={snapshot.imageDataUrl} alt="input" height={12} />
      ) : null}

      <Divider label="probes" />
      <List gap={0}>
        {snapshot.probes.map((probe) => {
          const audioSrc =
            probe.id === "text-to-speech" ? probe.result?.audioSrc : undefined;
          const imageUrls =
            probe.id === "image" ? (probe.result?.imageUrls ?? []) : [];
          return (
            <VStack key={probe.id} gap={0} agent={`probe-${probe.id}`}>
              <HStack gap={1} align="center">
                <Text tone={probeTone(probe)}>{probeMark(probe)}</Text>
                <VStack gap={0} grow={1}>
                  <Text bold wrap={false}>
                    {probe.label}
                  </Text>
                  <Text style="caption" tone="muted" wrap={false}>
                    {probe.modelType ?? "pure-js"}
                  </Text>
                </VStack>
                <Text style="caption" tone={probeTone(probe)}>
                  {resultLabel(probe)}
                </Text>
                <Button
                  variant="outline"
                  tone="default"
                  disabled={probe.running}
                  agent={`run-${probe.id}`}
                  onPress={dispatch(`run:${probe.id}`)}
                >
                  Run
                </Button>
              </HStack>
              {probe.result?.output ? (
                <Text style="caption" tone="muted" wrap>
                  {probe.result.output}
                </Text>
              ) : null}
              {audioSrc ? (
                <Text style="caption" tone="success" wrap={false}>
                  audio ready
                </Text>
              ) : null}
              {imageUrls.map((url) => (
                <Image key={url} src={url} alt="generated" height={12} />
              ))}
            </VStack>
          );
        })}
      </List>
    </Card>
  );
}

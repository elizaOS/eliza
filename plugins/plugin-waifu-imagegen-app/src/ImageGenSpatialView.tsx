/**
 * ImageGenSpatialView — the image-gen surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no waifu invoke-client or
 * Capacitor runtime import reaches the bundle).
 */

import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  Image,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Settled-charge fields the result strip renders, all optional on the wire. */
export interface ImageGenSnapshotCharge {
  totalCost?: number;
  currency?: string;
  balance?: number;
}

/** A generated image plus its settlement, projected for display only. */
export interface ImageGenSnapshotResult {
  imageUrl: string;
  prompt: string;
  aspect: string;
  charge?: ImageGenSnapshotCharge;
}

/** The full presentational state the view renders from. */
export interface ImageGenSnapshot {
  prompt: string;
  aspect: string;
  /** Model id (the wire value), e.g. `openai/gpt-image-2/text-to-image`. */
  model: string;
  /** Human label for the current model, when resolvable. */
  modelLabel?: string;
  busy: boolean;
  error: { message: string } | null;
  result: ImageGenSnapshotResult | null;
  promptValid: boolean;
  canGenerate: boolean;
  /** Creator markup percentage off app metadata, when configured. */
  markupPct?: number | null;
}

export interface ImageGenSpatialViewProps {
  snapshot: ImageGenSnapshot;
  /**
   * Dispatched action ids: `prompt:<text>` (prompt edit), `model:<id>`
   * (model select), `aspect:<ratio>` (aspect select), `generate`.
   */
  onAction?: (action: string) => void;
}

function formatUsd(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

export function ImageGenSpatialView({
  snapshot,
  onAction,
}: ImageGenSpatialViewProps) {
  const { result, error, busy } = snapshot;
  const settledTotal = formatUsd(result?.charge?.totalCost);
  const currency = result?.charge?.currency;
  const balance = formatUsd(result?.charge?.balance);

  return (
    <Card title="Image Generation" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="success" grow={1}>
          credits-settled
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.markupPct == null ? "markup n/a" : `markup +${snapshot.markupPct}%`}
        </Text>
      </HStack>

      <Divider label="prompt" />
      <Field
        label="prompt"
        kind="textarea"
        value={snapshot.prompt}
        placeholder="describe an image"
        disabled={busy}
        onChange={(v) => onAction?.(`prompt:${v}`)}
      />
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone="muted" grow={1}>
          model
        </Text>
        <Text style="caption">{snapshot.modelLabel || snapshot.model}</Text>
        <Text style="caption" tone="muted">
          aspect
        </Text>
        <Text style="caption">{snapshot.aspect}</Text>
      </HStack>

      <HStack gap={1}>
        <Button
          grow={1}
          agent="generate"
          disabled={!snapshot.canGenerate}
          onPress={() => onAction?.("generate")}
        >
          {busy ? "generating…" : "Generate"}
        </Button>
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error.message}
        </Text>
      ) : null}

      <Divider label="result" />
      {result?.imageUrl ? (
        <VStack gap={1}>
          <Image src={result.imageUrl} alt={result.prompt} width="100%" />
          <HStack gap={1} align="center" wrap>
            <Text style="caption" tone="muted" grow={1}>
              {result.aspect}
            </Text>
            {settledTotal ? (
              <Text style="caption">
                charged {settledTotal}
                {currency ? ` ${currency}` : ""}
              </Text>
            ) : null}
            {balance ? (
              <Text style="caption" tone="muted">
                balance {balance}
              </Text>
            ) : null}
          </HStack>
        </VStack>
      ) : (
        <Text tone="muted" align="center" style="caption">
          {busy ? "generating…" : "no image yet — credits settle on generate"}
        </Text>
      )}
    </Card>
  );
}

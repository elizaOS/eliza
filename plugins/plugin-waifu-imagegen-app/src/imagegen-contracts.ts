/**
 * Typed contract for the waifu.fun image-gen mini-app invoke endpoint.
 *
 * Mirrors the backend in `apps/api/src/routes/v2/apps.ts`
 * (`POST /v2/agents/:token/apps/image-gen/invoke`) and the existing waifu
 * frontend client (`apps/frontend/src/lib/wave-t/image-gen.ts`). Kept as a
 * standalone module so this app-plugin owns its own surface area and never
 * imports from the waifu monorepo.
 *
 * Backend contract:
 *
 *   POST /v2/agents/:token/apps/image-gen/invoke
 *     auth:  Steward bearer (Authorization: Bearer <jwt>)  OR
 *            x-waifu-app-invoke-key (agent runtime, server-side only)
 *     body:  { prompt: string (3..1800), style?: string, aspect?: AspectRatio,
 *              model?: string, idempotencyKey?: string }
 *     200:   { ok: true, data: ImageGenResult }
 *     400:   bad prompt / aspect
 *     401:   missing / invalid steward bearer
 *     402:   insufficient credits (Eliza Cloud charge failed)
 *     404:   image-gen app not registered / not live for this agent
 *     409:   duplicate idempotencyKey
 *     503:   misconfigured / db down
 */

export const IMAGE_GEN_APP_ID = "image-gen";

export const IMAGE_GEN_ASPECTS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

export type ImageGenAspect = (typeof IMAGE_GEN_ASPECTS)[number];

export interface ImageGenModelOption {
  readonly id: string;
  readonly label: string;
}

export const IMAGE_GEN_MODELS: readonly ImageGenModelOption[] = [
  { id: "openai/gpt-image-2/text-to-image", label: "GPT Image 2" },
  { id: "bytedance/seedream-v5.0-lite", label: "Seedream 5" },
  { id: "google/nano-banana-2/text-to-image", label: "Nano Banana 2" },
  { id: "qwen/qwen-image-2.0/text-to-image", label: "Qwen Image" },
] as const;

export type ImageGenModelId = (typeof IMAGE_GEN_MODELS)[number]["id"];

export const DEFAULT_IMAGE_GEN_MODEL_ID: ImageGenModelId =
  "openai/gpt-image-2/text-to-image";

export const DEFAULT_IMAGE_GEN_ASPECT: ImageGenAspect = "1:1";

export const IMAGE_GEN_PROMPT_MIN = 3;
export const IMAGE_GEN_PROMPT_MAX = 1800;

export interface ImageGenCharge {
  status?: string;
  currency?: string;
  baseCost?: number;
  creatorMarkup?: number;
  totalCost?: number;
  creatorEarnings?: number;
  balance?: number;
  detail?: string;
}

export interface ImageGenEarnings {
  revenueLifetimeUsd: string;
  revenue24hUsd: string;
  revenue7dUsd: string;
}

export interface ImageGenResult {
  appId: string;
  elizaCloudAppId: string;
  agentTokenAddress: string;
  imageUrl: string;
  prompt: string;
  aspect: string;
  charge: ImageGenCharge;
  earnings: ImageGenEarnings | null;
  billingReality: string;
}

export interface ImageGenInvokeResponse {
  ok: boolean;
  data?: ImageGenResult;
  error?: string;
}

export interface ImageGenInvokeInput {
  prompt: string;
  aspect?: ImageGenAspect;
  model?: ImageGenModelId;
  style?: string;
  idempotencyKey?: string;
}

/** Recognised failure kinds surfaced to the AppView so it can branch on status. */
export type ImageGenErrorKind =
  | "auth"
  | "insufficient-credits"
  | "not-available"
  | "duplicate"
  | "bad-request"
  | "misconfigured"
  | "unknown";

export interface ImageGenError {
  kind: ImageGenErrorKind;
  status: number;
  message: string;
}

export function isImageGenError(value: unknown): value is ImageGenError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

/** Map an HTTP status + message onto a typed {@link ImageGenError}. */
export function classifyImageGenStatus(
  status: number,
  message: string,
): ImageGenError {
  switch (status) {
    case 401:
      return { kind: "auth", status, message: "sign in to generate images" };
    case 402:
      return {
        kind: "insufficient-credits",
        status,
        message: "not enough credits to generate",
      };
    case 404:
      return {
        kind: "not-available",
        status,
        message: "image generation is not available for this agent",
      };
    case 409:
      return {
        kind: "duplicate",
        status,
        message: "that request was already submitted",
      };
    case 400:
      return {
        kind: "bad-request",
        status,
        message: message || "invalid request",
      };
    case 503:
      return {
        kind: "misconfigured",
        status,
        message: "image generation is temporarily unavailable",
      };
    default:
      return {
        kind: "unknown",
        status,
        message: message || "image generation failed",
      };
  }
}

/** Pull the configured creator markup pct off an app metadata bag. */
export function imageGenMarkupPct(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).inferenceMarkupPercentage;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read the metered model label off an app metadata bag. */
export function imageGenModelLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).model;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

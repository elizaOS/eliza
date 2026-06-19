/**
 * Image-gen invoke client. Ports the auth + error-mapping behaviour of the
 * waifu frontend (`invokeImageGen`) into a self-contained, fetch-based call so
 * the AppView can reach the waifu API from inside the ElizaOS web UI canvas.
 *
 * Auth precedence (matches the backend's accepted credentials):
 *   1. agent-app invoke key  -> header `x-waifu-app-invoke-key`
 *   2. Steward JWT bearer    -> header `Authorization: Bearer <jwt>`
 *
 * 402 (insufficient credits) and 404 (app not live) are surfaced as typed
 * {@link ImageGenError}s so the view can branch and render them gracefully.
 */

import type { WaifuImageGenRuntimeConfig } from "./imagegen-config";
import {
  classifyImageGenStatus,
  type ImageGenError,
  type ImageGenInvokeInput,
  type ImageGenInvokeResponse,
  type ImageGenResult,
} from "./imagegen-contracts";

function buildAuthHeaders(config: WaifuImageGenRuntimeConfig): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.appInvokeKey) {
    headers["x-waifu-app-invoke-key"] = config.appInvokeKey;
  } else if (config.stewardJwt) {
    headers.Authorization = `Bearer ${config.stewardJwt}`;
  }
  return headers;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/**
 * Invoke the image-gen mini-app for the configured agent. Resolves with the
 * settled {@link ImageGenResult}, or rejects with a typed {@link ImageGenError}
 * (branch on `.kind`).
 */
export async function invokeImageGen(
  config: WaifuImageGenRuntimeConfig,
  input: ImageGenInvokeInput,
): Promise<ImageGenResult> {
  if (!config.agentTokenAddress) {
    throw {
      kind: "misconfigured",
      status: 503,
      message: "no agent configured for image generation",
    } satisfies ImageGenError;
  }
  if (!config.appInvokeKey && !config.stewardJwt) {
    throw {
      kind: "auth",
      status: 401,
      message: "sign in to generate images",
    } satisfies ImageGenError;
  }

  const body: Record<string, unknown> = {
    prompt: input.prompt,
    aspect: input.aspect ?? "1:1",
  };
  if (input.model) body.model = input.model;
  if (input.style?.trim()) body.style = input.style.trim();
  if (input.idempotencyKey) body.idempotencyKey = input.idempotencyKey;

  const url = `${config.apiBase}/v2/agents/${encodeURIComponent(
    config.agentTokenAddress,
  )}/apps/image-gen/invoke`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildAuthHeaders(config),
      body: JSON.stringify(body),
    });
  } catch (caught) {
    throw {
      kind: "unknown",
      status: 0,
      message:
        caught instanceof Error
          ? caught.message
          : "could not reach image generation",
    } satisfies ImageGenError;
  }

  const payload = (await response
    .json()
    .catch(() => ({}))) as ImageGenInvokeResponse;

  if (!response.ok) {
    throw classifyImageGenStatus(
      response.status,
      readErrorMessage(payload, "image generation failed"),
    );
  }

  if (!payload?.ok || !payload.data?.imageUrl) {
    throw {
      kind: "unknown",
      status: 500,
      message: "image generation returned no image",
    } satisfies ImageGenError;
  }

  return payload.data;
}

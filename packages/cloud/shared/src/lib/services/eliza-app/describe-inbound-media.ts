/**
 * Describes inbound platform image media with a vision model so the shared
 * Personal turn (whose default text model cannot see images) receives real
 * image content instead of a bare provider URL. Fail-closed by design: the
 * `ELIZA_APP_INBOUND_MEDIA_VISION` binding must be exactly "true" and a vision
 * provider must be configured, otherwise the typed disabled error tells the
 * caller to keep the un-enriched message. Media bytes are fetched through the
 * SSRF-guarded `safeFetch` after an https/domain allowlist re-check, with
 * redirects rejected outright (a followed hop is only SSRF-checked, not
 * allowlist-checked), a content-type gate, and a streamed size cap, so a
 * compromised or spoofed gateway payload cannot make this Worker read
 * arbitrary or unbounded bytes.
 *
 * Every enrichment failure is a typed `InboundMediaDescriptionError`; callers
 * degrade to the raw media-URL text on it and must never fabricate a
 * description. A truncated completion is rejected, not returned: a clipped
 * description entering conversation history as if complete violates the
 * repository prompt-integrity rule.
 */

import { ElizaError } from "@elizaos/core";
import { generateText } from "ai";
import type { Bindings } from "../../../types/cloud-worker-env";
import { getLanguageModel, ProviderConfigurationError } from "../../providers/language-model";
import { safeFetch } from "../../security/safe-fetch";
import { isAllowedBlooioMediaUrl } from "./blooio-media-allowlist";

export const INBOUND_MEDIA_VISION_MODEL = "openai/gpt-5.4-mini";
export const MAX_INBOUND_MEDIA_IMAGES = 4;
// Mirrors the Telegram voice ceiling: keeps the fetched copies bounded in a
// 128 MiB Worker isolate while covering ordinary conversational photos.
export const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;
const INBOUND_MEDIA_FETCH_TIMEOUT_MS = 15_000;
const INBOUND_MEDIA_VISION_TIMEOUT_MS = 45_000;
// Output-side ceiling only; the completion is rejected (never clipped) when
// the model reports it ran into this bound.
const INBOUND_MEDIA_DESCRIPTION_MAX_OUTPUT_TOKENS = 768;

const DESCRIPTION_PROMPT =
  "Describe the attached image(s) for an assistant that cannot see them. " +
  "State the subject, any visible text verbatim, and details a reply would " +
  "need. Describe only what is visible; do not guess at hidden content.";

/** Vision enrichment is off for this deployment; keep the un-enriched turn. */
export class InboundMediaVisionDisabledError extends ElizaError {
  override readonly name = "InboundMediaVisionDisabledError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, {
      code: "INBOUND_MEDIA_VISION_DISABLED",
      severity: "ephemeral",
      ...options,
    });
  }
}

export type InboundMediaDescriptionFailureReason =
  | "media_fetch_failed"
  | "unsupported_media_type"
  | "media_too_large"
  | "vision_model_failed"
  | "empty_description"
  | "incomplete_description";

/** One enrichment attempt failed; callers degrade to the raw media-URL text. */
export class InboundMediaDescriptionError extends ElizaError {
  override readonly name = "InboundMediaDescriptionError";
  readonly reason: InboundMediaDescriptionFailureReason;

  constructor(
    message: string,
    reason: InboundMediaDescriptionFailureReason,
    options?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message, {
      code: "INBOUND_MEDIA_DESCRIPTION_FAILED",
      severity: "ephemeral",
      cause: options?.cause,
      context: { reason, ...options?.context },
    });
    this.reason = reason;
  }
}

interface FetchedInboundImage {
  bytes: Uint8Array;
  mediaType: string;
}

async function readImageBytesWithCap(response: Response, url: string): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new InboundMediaDescriptionError(
      "Inbound media declares a size above the image ceiling",
      "media_too_large",
      { context: { url, declaredLength } },
    );
  }
  if (!response.body) {
    throw new InboundMediaDescriptionError(
      "Inbound media response carried no body",
      "media_fetch_failed",
      { context: { url } },
    );
  }
  // Content-Length is provider-asserted; enforce the ceiling on the actual
  // stream so a lying header cannot buffer an unbounded body.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INBOUND_IMAGE_BYTES) {
      await reader.cancel();
      throw new InboundMediaDescriptionError(
        "Inbound media exceeds the image ceiling",
        "media_too_large",
        { context: { url } },
      );
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new InboundMediaDescriptionError(
      "Inbound media response body was empty",
      "media_fetch_failed",
      { context: { url } },
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchInboundImage(url: string): Promise<FetchedInboundImage> {
  let response: Response;
  try {
    // redirect: "error" — safeFetch re-validates redirect hops only against
    // the SSRF/private-IP guard, not the Blooio allowlist, so following even
    // one hop would let an open redirect on an allowlisted host fetch bytes
    // from any public origin. Fail the fetch instead; if Blooio media is ever
    // served via a CDN redirect, widen this deliberately with a per-hop
    // allowlist re-check.
    response = await safeFetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(INBOUND_MEDIA_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J2 wrap transport/SSRF-guard failures with the media URL context.
    throw new InboundMediaDescriptionError("Inbound media fetch failed", "media_fetch_failed", {
      cause: error,
      context: { url },
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new InboundMediaDescriptionError(
      `Inbound media fetch returned HTTP ${response.status}`,
      "media_fetch_failed",
      { context: { url, status: response.status } },
    );
  }
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mediaType.startsWith("image/")) {
    await response.body?.cancel();
    throw new InboundMediaDescriptionError(
      "Inbound media is not an image",
      "unsupported_media_type",
      { context: { url, mediaType } },
    );
  }
  return { bytes: await readImageBytesWithCap(response, url), mediaType };
}

/**
 * Fetches every allowlisted image URL and returns one vision-model description
 * covering all of them. Throws {@link InboundMediaVisionDisabledError} when the
 * flag is off or no vision provider is configured, and
 * {@link InboundMediaDescriptionError} on any per-turn enrichment failure.
 */
export async function describeInboundImageMedia(
  env: Pick<Bindings, "ELIZA_APP_INBOUND_MEDIA_VISION">,
  urls: readonly string[],
): Promise<string> {
  if (env.ELIZA_APP_INBOUND_MEDIA_VISION?.trim() !== "true") {
    throw new InboundMediaVisionDisabledError(
      "Inbound media vision is disabled for this deployment",
    );
  }
  if (urls.length === 0 || urls.length > MAX_INBOUND_MEDIA_IMAGES) {
    throw new ElizaError("Inbound media description got an invalid URL count", {
      code: "INBOUND_MEDIA_URL_COUNT_INVALID",
      context: { count: urls.length, max: MAX_INBOUND_MEDIA_IMAGES },
    });
  }
  for (const url of urls) {
    // Defence-in-depth: the route schema already enforces the allowlist, so a
    // disallowed URL here is a broken caller contract, not a degradable turn.
    if (!isAllowedBlooioMediaUrl(url)) {
      throw new ElizaError("Inbound media URL is not on the Blooio allowlist", {
        code: "INBOUND_MEDIA_URL_DISALLOWED",
        context: { url },
      });
    }
  }
  let model: ReturnType<typeof getLanguageModel>;
  try {
    model = getLanguageModel(INBOUND_MEDIA_VISION_MODEL);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      // error-policy:J2 a missing vision provider key means the capability is
      // off for this deployment; retype so callers keep the un-enriched turn.
      throw new InboundMediaVisionDisabledError("Inbound media vision has no configured provider", {
        cause: error,
      });
    }
    throw error;
  }
  // allSettled instead of all: on a mixed outcome, `all` would reject while
  // sibling fetches still hold sockets and buffering bodies in the isolate.
  // Waiting for every settle keeps the error path leak-free (each fetch either
  // fully reads its capped body or cancels it itself), then the first failure
  // is rethrown unchanged.
  const settledImages = await Promise.allSettled(urls.map(fetchInboundImage));
  const firstFailure = settledImages.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstFailure) {
    throw firstFailure.reason;
  }
  const images = settledImages.map(
    (result) => (result as PromiseFulfilledResult<FetchedInboundImage>).value,
  );
  let completion: Awaited<ReturnType<typeof generateText>>;
  try {
    completion = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DESCRIPTION_PROMPT },
            ...images.map((image) => ({
              type: "image" as const,
              image: image.bytes,
              mediaType: image.mediaType,
            })),
          ],
        },
      ],
      maxOutputTokens: INBOUND_MEDIA_DESCRIPTION_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(INBOUND_MEDIA_VISION_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J2 retype provider failures so callers degrade instead of
    // dropping the user's turn.
    throw new InboundMediaDescriptionError(
      "Vision provider failed to describe inbound media",
      "vision_model_failed",
      { cause: error, context: { model: INBOUND_MEDIA_VISION_MODEL } },
    );
  }
  const description = completion.text.trim();
  if (!description) {
    throw new InboundMediaDescriptionError(
      "Vision provider returned an empty description",
      "empty_description",
      { context: { model: INBOUND_MEDIA_VISION_MODEL } },
    );
  }
  // Prompt integrity: a description clipped at the output ceiling must be
  // rejected, never delivered as if it were the complete image content.
  if (completion.finishReason === "length") {
    throw new InboundMediaDescriptionError(
      "Vision provider truncated the description at the output ceiling",
      "incomplete_description",
      { context: { model: INBOUND_MEDIA_VISION_MODEL } },
    );
  }
  return description;
}

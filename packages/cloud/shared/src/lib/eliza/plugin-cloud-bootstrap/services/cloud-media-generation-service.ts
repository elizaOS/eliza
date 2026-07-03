import {
  type IAgentRuntime,
  IMediaGenerationService,
  type ImageGenerationResult,
  logger,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  ModelType,
  ServiceType,
} from "@elizaos/core";

type ImageResultLike =
  | string
  | (Partial<ImageGenerationResult> & {
      imageUrl?: string;
      imageBase64?: string;
      mimeType?: string;
      revisedPrompt?: string;
    });

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function imageMimeTypeFromUrl(url: string): string | undefined {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)/.exec(url);
    return match?.[1];
  }

  try {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return extension ? IMAGE_MIME_BY_EXTENSION[extension] : undefined;
  } catch {
    return undefined;
  }
}

// The cloud image path authenticates to Eliza Cloud with ELIZAOS_CLOUD_API_KEY
// (plugin-elizacloud `getApiKey`). plugin-elizacloud registers the
// ModelType.IMAGE handler statically — it is present even when the key is
// absent — so a registered handler alone is NOT proof the backend can generate.
// Without a usable key every image call 401s ("Invalid or expired API key"),
// which is what turned image generation 0/7 live (#11953) with every failure
// arriving AFTER a user-facing "generating now" ack. Gate availability on the
// key so the planner never offers a tool that is guaranteed to fail.
const CLOUD_MEDIA_API_KEY_SETTING = "ELIZAOS_CLOUD_API_KEY";

function hasCloudMediaKey(runtime: IAgentRuntime): boolean {
  const fromSetting = runtime.getSetting(CLOUD_MEDIA_API_KEY_SETTING);
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) {
    return true;
  }
  const env =
    typeof globalThis === "object" && "process" in globalThis
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      : undefined;
  const fromEnv = env?.[CLOUD_MEDIA_API_KEY_SETTING];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0;
}

function hasImageModelHandler(runtime: IAgentRuntime): boolean {
  return typeof runtime.getModel(ModelType.IMAGE) === "function";
}

/**
 * How long the service withholds itself after a hard backing failure before it
 * allows one re-probe. `hasCloudMediaKey` only proves a key is PRESENT, not that
 * it is valid — a present-but-expired/revoked key (the literal #11953 symptom,
 * "Invalid or expired API key") passes the presence check yet 401s on every
 * call. This breaker catches that case reactively: it opens on the first hard
 * failure so the tool drops from the catalog instead of promising-then-failing,
 * and half-opens after the cooldown to re-probe (closing on success — self-heal
 * once the key is rotated). Short enough to recover fast, long enough that a run
 * of requests during an outage doesn't each re-hit the dead provider.
 */
const HEALTH_RECHECK_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * A `generateMedia` failure that means the BACKING provider is unusable for
 * every request (dead/expired/revoked key, unauthorized, not configured, quota
 * exhausted) — as opposed to a per-request failure (content rejected, transient
 * network blip, empty result). Only the former should open the health breaker:
 * disabling the whole action on a one-off content rejection would be wrong.
 */
function isBackingUnavailableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\bapi[\s._-]?key\b/.test(message) ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("expired") ||
    message.includes("invalid key") ||
    message.includes("not configured") ||
    message.includes("no image generation model") ||
    message.includes("quota") ||
    message.includes("insufficient") ||
    message.includes("billing") ||
    message.includes("payment required") ||
    /\b40[123]\b/.test(message)
  );
}

function normalizeImageResult(result: ImageResultLike | undefined): MediaGenerationResponse | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    return {
      mediaType: "image",
      url: result,
      imageUrl: result,
      mimeType: imageMimeTypeFromUrl(result),
    };
  }

  const url =
    typeof result.url === "string"
      ? result.url
      : typeof result.imageUrl === "string"
        ? result.imageUrl
        : undefined;

  if (url) {
    return {
      mediaType: "image",
      url,
      imageUrl: url,
      mimeType: result.mimeType ?? imageMimeTypeFromUrl(url),
      revisedPrompt: result.revisedPrompt,
    };
  }

  if (typeof result.imageBase64 === "string" && result.imageBase64.length > 0) {
    const mimeType = result.mimeType ?? "image/png";
    const imageUrl = result.imageBase64.startsWith("data:")
      ? result.imageBase64
      : `data:${mimeType};base64,${result.imageBase64}`;

    return {
      mediaType: "image",
      url: imageUrl,
      imageUrl,
      imageBase64: result.imageBase64,
      mimeType,
      revisedPrompt: result.revisedPrompt,
    };
  }

  return null;
}

export class CloudMediaGenerationService extends IMediaGenerationService {
  static override readonly serviceType = ServiceType.MEDIA_GENERATION;

  /**
   * `null` = healthy. A timestamp = when the last hard backing failure opened
   * the health breaker (see `isBackingUnavailableError`). While the breaker is
   * open, `canGenerateMedia` reports the service unavailable so the
   * GENERATE_MEDIA action drops out of the planner catalog even when a key is
   * present but invalid/expired (#11953).
   */
  private unhealthySince: number | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<CloudMediaGenerationService> {
    return new CloudMediaGenerationService(runtime);
  }

  async stop(): Promise<void> {}

  override canGenerateMedia(
    request: Pick<MediaGenerationRequest, "mediaType" | "audioKind">,
  ): boolean {
    if (request.mediaType !== "image") {
      return false;
    }
    // Presence checks (a key is configured + an IMAGE handler is registered)
    // catch an ABSENT key up front; the breaker catches a PRESENT-but-invalid
    // key that only fails at call time.
    return (
      hasImageModelHandler(this.runtime) &&
      hasCloudMediaKey(this.runtime) &&
      !this.isHealthBreakerOpen()
    );
  }

  private isHealthBreakerOpen(): boolean {
    if (this.unhealthySince === null) {
      return false;
    }
    // Half-open once the cooldown elapses: allow one re-probe. The breaker only
    // fully closes when a generation actually succeeds (`markHealthy`).
    if (Date.now() - this.unhealthySince >= HEALTH_RECHECK_COOLDOWN_MS) {
      return false;
    }
    return true;
  }

  private markUnhealthy(error: unknown): void {
    this.unhealthySince = Date.now();
    logger.warn(
      {
        src: "cloud:media_generation",
        error: error instanceof Error ? error.message : String(error),
        cooldownMs: HEALTH_RECHECK_COOLDOWN_MS,
      },
      "[GENERATE_MEDIA] backing image provider rejected the request (key invalid/expired?) — withholding the action from the catalog until re-probe",
    );
  }

  private markHealthy(): void {
    if (this.unhealthySince !== null) {
      logger.info(
        { src: "cloud:media_generation" },
        "[GENERATE_MEDIA] backing image provider recovered — action re-enabled",
      );
    }
    this.unhealthySince = null;
  }

  async generateMedia(request: MediaGenerationRequest): Promise<MediaGenerationResponse> {
    if (request.mediaType !== "image") {
      throw new Error(`Cloud media generation currently supports image output only.`);
    }

    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error("Media generation prompt is required.");
    }

    let imageResponse: Awaited<ReturnType<IAgentRuntime["useModel"]>>;
    try {
      imageResponse = await this.runtime.useModel(ModelType.IMAGE, {
        prompt,
        ...(request.size ? { size: request.size } : {}),
      });
    } catch (error) {
      // A dead/expired key (or other hard backing failure) fails every request
      // the same way — open the breaker so subsequent turns withhold the action
      // instead of re-promising and re-failing.
      if (isBackingUnavailableError(error)) {
        this.markUnhealthy(error);
      }
      throw error;
    }

    const imageResults = Array.isArray(imageResponse)
      ? (imageResponse as ImageResultLike[])
      : typeof imageResponse === "string"
        ? [imageResponse]
        : [];
    const media = normalizeImageResult(imageResults[0]);

    if (!media?.imageUrl && !media?.url) {
      logger.error(
        {
          src: "cloud:media_generation",
          mediaType: request.mediaType,
          prompt,
        },
        "Media generation failed - no valid image result received",
      );
      throw new Error("Image model returned no media result.");
    }

    // A real generation landed: the backing provider is live, so clear any
    // previously-tripped breaker (self-heal once the key is rotated).
    this.markHealthy();

    return {
      ...media,
      mediaType: "image",
      revisedPrompt: media.revisedPrompt,
      provider: "runtime-model",
    };
  }
}

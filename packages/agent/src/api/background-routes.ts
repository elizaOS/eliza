/**
 * HTTP route backing the Background view's "Generate" control: turn a text
 * prompt into a durable, same-origin background image.
 *
 * Generation runs through the agent's media-generation service (cloud or local
 * image provider). Providers return base64 bytes, a `data:` URL, or a remote
 * http(s) URL; all three are normalized into the content-addressed media store
 * so the client persists a short, stable `/api/media/<hash>` reference rather
 * than a multi-MB data URL.
 */

import { Buffer } from "node:buffer";
import {
  fetchRemoteMedia,
  type IMediaGenerationService,
  logger,
  type MediaGenerationRequest,
  type Route,
  ServiceType,
} from "@elizaos/core";
import {
  persistDataUrl,
  persistMediaBytes,
  pinBackgroundMedia,
} from "./media-store.ts";

interface GenerateImageBody {
  prompt?: unknown;
  size?: unknown;
}

function jsonResult(status: number, body: unknown) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  };
}

/** Cap on a re-hosted background image (generated art is small). */
const BACKGROUND_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

/** Normalize a generated image (base64 / data URL / remote URL) to a served URL. */
async function persistGeneratedImage(
  imageBase64: string | undefined,
  imageUrl: string,
  mimeType: string,
): Promise<string> {
  if (imageBase64) {
    return persistMediaBytes(Buffer.from(imageBase64, "base64"), mimeType).url;
  }
  if (imageUrl.startsWith("data:")) {
    const persisted = persistDataUrl(imageUrl);
    if (persisted) return persisted.url;
  }
  if (/^https?:\/\//.test(imageUrl)) {
    try {
      // SSRF-guarded server-side fetch (mandated for all remote media fetches).
      const { buffer, contentType } = await fetchRemoteMedia({
        url: imageUrl,
        maxBytes: BACKGROUND_IMAGE_MAX_BYTES,
      });
      return persistMediaBytes(buffer, contentType ?? mimeType).url;
    } catch (err) {
      logger.warn(
        `[background] could not re-host generated image ${imageUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Already a usable URL we couldn't (or needn't) re-host.
  return imageUrl;
}

export const backgroundGenerateImageRoute: Route = {
  type: "POST",
  path: "/api/background/generate-image",
  // Serve at the literal path, not under the plugin-name prefix.
  rawPath: true,
  name: "background-generate-image",
  routeHandler: async (ctx) => {
    const body = (ctx.body ?? {}) as GenerateImageBody;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      return jsonResult(400, { error: "A prompt is required." });
    }

    const service = ctx.runtime.getService<IMediaGenerationService>(
      ServiceType.MEDIA_GENERATION,
    );
    if (!service) {
      return jsonResult(503, { error: "Media generation is not available." });
    }

    const request: MediaGenerationRequest = {
      mediaType: "image",
      prompt,
      size: typeof body.size === "string" ? body.size : undefined,
    };
    if (!(await service.canGenerateMedia(request))) {
      return jsonResult(503, { error: "Image generation is not configured." });
    }

    try {
      const result = await service.generateMedia(request);
      const sourceUrl = result.imageUrl ?? result.url ?? "";
      if (!result.imageBase64 && !sourceUrl) {
        return jsonResult(502, {
          error: "Image generation returned no image.",
        });
      }
      const url = await persistGeneratedImage(
        result.imageBase64,
        sourceUrl,
        result.mimeType ?? "image/png",
      );
      // The wallpaper's only referent is the client's persisted config, which
      // the orphan GC cannot see — pin it so it survives the daily sweep.
      pinBackgroundMedia(url);
      return jsonResult(200, { url });
    } catch (err) {
      // Translate a provider/transport failure into a clear client error.
      return jsonResult(502, {
        error: err instanceof Error ? err.message : "Image generation failed.",
      });
    }
  },
};

interface UploadImageBody {
  dataUrl?: unknown;
}

/**
 * Cap on an uploaded wallpaper data URL. The client downscales to ≤4 MB of
 * bytes before uploading; base64 inflates ~4/3, so allow modest headroom.
 */
const BACKGROUND_UPLOAD_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Re-host a user-picked wallpaper into the content-addressed media store
 * (authenticated write — the same normalization the generate route performs),
 * so the client persists a short, stable `/api/media/<hash>` reference instead
 * of a multi-MB data URL that silently blows the localStorage quota.
 */
export const backgroundUploadImageRoute: Route = {
  type: "POST",
  path: "/api/background/upload-image",
  rawPath: true,
  name: "background-upload-image",
  routeHandler: async (ctx) => {
    const body = (ctx.body ?? {}) as UploadImageBody;
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl.trim() : "";
    if (!dataUrl.startsWith("data:image/")) {
      return jsonResult(400, { error: "An image data URL is required." });
    }
    if (dataUrl.length > BACKGROUND_UPLOAD_MAX_CHARS) {
      return jsonResult(413, { error: "That image is too large." });
    }
    const persisted = persistDataUrl(dataUrl);
    if (!persisted) {
      return jsonResult(400, { error: "Could not decode that image." });
    }
    // The wallpaper's only referent is the client's persisted config, which
    // the orphan GC cannot see — pin it so it survives the daily sweep.
    pinBackgroundMedia(persisted.url);
    logger.info(
      `[background] re-hosted uploaded wallpaper as ${persisted.url}`,
    );
    return jsonResult(200, { url: persisted.url });
  },
};

/** Convert benchmark image bytes into native, content-addressed attachments. */
import { persistMediaBytes } from "@elizaos/agent/api/media-store";
import {
  ContentType,
  ElizaError,
  type IAgentRuntime,
  type Media,
  ModelType,
} from "@elizaos/core";

import type { BenchmarkContext } from "./plugin.js";

type InlineImage = Media & { _data: string; _mimeType: string };

function invalid(message: string): never {
  throw new ElizaError(message, {
    code: "BENCHMARK_IMAGE_INVALID",
    severity: "fatal",
  });
}

export function prepareBenchmarkImages(context: BenchmarkContext): {
  context: BenchmarkContext;
  attachments: InlineImage[];
} {
  const inputs: unknown[] = [];
  if (context.screenshot_base64 != null) {
    inputs.push({
      data_base64: context.screenshot_base64,
      media_type: "image/png",
    });
  }
  if (context.attachments != null) {
    if (!Array.isArray(context.attachments))
      invalid("Benchmark attachments must be an array");
    inputs.push(...context.attachments);
  }
  const attachments = inputs.map((input): InlineImage => {
    if (!input || typeof input !== "object")
      invalid("Benchmark image must be an object");
    const image = input as Record<string, unknown>;
    const encoded = image.data_base64;
    if (typeof encoded !== "string" || !encoded.length) {
      invalid(
        "Benchmark images require inline data_base64 bytes; paths and URLs are not image delivery",
      );
    }
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.toString("base64") !== encoded)
      invalid("Benchmark image base64 is invalid");
    const mime = image.media_type;
    const isPng = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const isWebp =
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP";
    if (
      !(
        (mime === "image/png" && isPng) ||
        (mime === "image/jpeg" && isJpeg) ||
        (mime === "image/webp" && isWebp)
      )
    ) {
      invalid("Benchmark image MIME must match PNG, JPEG, or WebP bytes");
    }
    const stored = persistMediaBytes(bytes, mime as string);
    return {
      id: stored.hash,
      url: stored.url,
      sha256: stored.hash,
      contentType: ContentType.IMAGE,
      mimeType: mime as string,
      size: bytes.length,
      source: "benchmark",
      _data: encoded,
      _mimeType: mime as string,
    };
  });
  const normalized = { ...context };
  delete normalized.screenshot_base64;
  if (attachments.length) {
    normalized.attachments = attachments.map(
      ({ _data, _mimeType, ...reference }) => reference,
    );
    normalized.image_input_mode = "native_image_description";
  }
  return { context: normalized, attachments };
}

/** Use the native attachment processor and reject unavailable vision explicitly. */
export async function processBenchmarkImages(
  runtime: IAgentRuntime,
  attachments: Media[],
): Promise<Media[]> {
  if (!attachments.length) return [];
  const processor = runtime.messageService?.processAttachments;
  const disabled = runtime.getSetting("DISABLE_IMAGE_DESCRIPTION");
  if (
    !processor ||
    disabled === true ||
    disabled === "true" ||
    !runtime.getModel(ModelType.IMAGE_DESCRIPTION)
  ) {
    throw new ElizaError(
      "This benchmark requires a configured native image-description provider",
      {
        code: "BENCHMARK_VISION_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  const processed = await processor.call(
    runtime.messageService,
    runtime,
    attachments,
  );
  if (
    processed.length !== attachments.length ||
    processed.some(
      (image) =>
        image.notProcessed ||
        image.enrichmentFailure ||
        !image.description?.trim(),
    )
  ) {
    throw new ElizaError(
      "Native image processing did not describe every benchmark image",
      {
        code: "BENCHMARK_VISION_FAILED",
        severity: "fatal",
      },
    );
  }
  return processed;
}

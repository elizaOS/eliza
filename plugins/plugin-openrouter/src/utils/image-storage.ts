import { logger, getGeneratedDir } from "@elizaos/core";

function isBrowser(): boolean {
  return typeof globalThis !== "undefined" && (globalThis as any).document;
}

// Restrict identifiers to a safe subset to prevent path traversal/FS escape
function sanitizeId(id: string): string {
  const src = (id ?? "").toString();
  const normalized = src.normalize("NFKC");
  let safe = normalized.replace(/[^a-zA-Z0-9_-]/g, "_");
  safe = safe.replace(/_+/g, "_");
  safe = safe.slice(0, 64);
  safe = safe.replace(/^_+|_+$/g, "");
  return safe || "agent";
}

// Lightweight base64 decoder that avoids Node Buffer and works in browser/Node
function base64ToBytes(base64: string): Uint8Array {
  // Remove padding
  const cleaned = base64.replace(/\s+/g, "");
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup: number[] = new Array(256).fill(-1);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  const len = cleaned.length;
  let pad = 0;
  if (len >= 2 && cleaned[len - 1] === "=") pad++;
  if (len >= 2 && cleaned[len - 2] === "=") pad++;
  const outLen = ((len * 3) >> 2) - pad;
  const out = new Uint8Array(outLen);

  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = lookup[cleaned.charCodeAt(i)];
    const c1 = lookup[cleaned.charCodeAt(i + 1)];
    const c2 = lookup[cleaned.charCodeAt(i + 2)];
    const c3 = lookup[cleaned.charCodeAt(i + 3)];
    const n = (c0 << 18) | (c1 << 12) | ((c2 & 63) << 6) | (c3 & 63);
    if (o < outLen) out[o++] = (n >> 16) & 255;
    if (o < outLen) out[o++] = (n >> 8) & 255;
    if (o < outLen) out[o++] = n & 255;
  }
  return out;
}

/**
 * Save base64 image to disk and return the file path
 */
export async function saveBase64Image(
  base64Url: string,
  agentId: string,
  index: number = 0,
): Promise<string | null> {
  if (isBrowser()) {
    return null;
  }
  // Extract base64 data and extension with MIME type validation
  const m = base64Url.match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!m) return null;

  const mime = m[1];
  const base64Data = m[2];

  // Whitelist of allowed MIME types mapped to extensions
  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };

  const extension = extMap[mime];
  if (!extension) return null;

  // Use ElizaOS convention: .eliza/data/generated/{agentId}/
  const { join } = await import("node:path");
  const safeAgentId = sanitizeId(agentId);
  const baseDir = join(getGeneratedDir(), safeAgentId);

  // Create directory if it doesn't exist
  const { existsSync } = await import("node:fs");
  if (!existsSync(baseDir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(baseDir, { recursive: true });
  }

  // Generate filename with timestamp
  const timestamp = Date.now();
  const filename = `image_${timestamp}_${index}.${extension}`;
  const filepath = join(baseDir, filename);

  // Save image to disk
  const buffer = base64ToBytes(base64Data);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filepath, buffer);

  logger.info(`[OpenRouter] Saved generated image to ${filepath}`);

  // Return only the file path for Discord/Telegram to read
  return filepath;
}

/**
 * Delete a specific image file
 */
export function deleteImage(filepath: string): void {
  if (isBrowser()) {
    return;
  }
  try {
    (async () => {
      const { existsSync, unlinkSync } = await import("node:fs");
      if (existsSync(filepath)) {
        unlinkSync(filepath);
        logger.debug(`[OpenRouter] Deleted image: ${filepath}`);
      }
    })().catch((error) => {
      logger.warn(
        `[OpenRouter] Failed to delete image ${filepath}:`,
        String(error),
      );
    });
  } catch (error) {
    logger.warn(
      `[OpenRouter] Failed to delete image ${filepath}:`,
      String(error),
    );
  }
}

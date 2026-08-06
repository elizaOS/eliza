import type { ModelMessage } from "ai";
import { existsSync, readFileSync } from "fs";
import { extname, isAbsolute, resolve } from "path";

export async function buildVisionUserMessages(
  prompt: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const imageSources = extractImageSourcesFromPrompt(prompt);
  if (imageSources.length === 0) {
    return [{ role: "user", content: prompt }];
  }

  const content: Array<{ type: "file"; data: Uint8Array | URL; mediaType: string } | { type: "text"; text: string }> =
    [];

  for (const source of imageSources) {
    const resolved = await resolveVisionImageSource(source, cwd, abortSignal).catch(() => null);
    if (!resolved) continue;
    content.push({
      type: "file",
      data: resolved.sourceUrl ? new URL(resolved.sourceUrl) : resolved.data,
      mediaType: resolved.mediaType,
    });
  }

  if (content.length === 0) {
    return [{ role: "user", content: prompt }];
  }

  content.push({ type: "text", text: prompt });
  return [{ role: "user", content }];
}

function extractImageSourcesFromPrompt(prompt: string): string[] {
  const matches = prompt.match(/((?:file:\/\/|https?:\/\/|\/)[^\n]*?\.(?:png|jpe?g))/gi) ?? [];
  const seen = new Set<string>();
  const sources: string[] = [];

  for (const match of matches) {
    const normalized = normalizeImageSourceText(match);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    sources.push(normalized);
  }

  return sources;
}

async function resolveVisionImageSource(
  source: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: string; sourceUrl?: string }> {
  if (isHttpUrl(source)) {
    const response = await fetch(source, { signal: abortSignal });
    if (!response.ok) {
      throw new Error(`Source image download failed: ${response.status} ${response.statusText}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      data,
      mediaType: response.headers.get("content-type") || guessImageMediaType(source),
      sourceUrl: source,
    };
  }

  const localPath = source.startsWith("file://") ? decodeFileUrl(source) : resolveLocalImagePath(source, cwd);
  if (!existsSync(localPath)) {
    throw new Error(`Source image not found: ${source}`);
  }

  return {
    data: readFileSync(localPath),
    mediaType: guessImageMediaType(localPath),
  };
}

function normalizeImageSourceText(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\([ "'()[\]{}])/g, "$1");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeFileUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value;
  }
}

function resolveLocalImagePath(source: string, cwd: string): string {
  return isAbsolute(source) ? source : resolve(cwd, source);
}

function guessImageMediaType(pathLike: string): string {
  switch (extname(pathLike).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      return "image/png";
  }
}

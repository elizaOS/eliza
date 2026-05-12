import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface DownloadedAdMedia {
  url: string;
  bytes: Uint8Array;
  base64: string;
  contentType: string;
  fileName: string;
}

export function mediaFileName(input: {
  name?: string;
  url: string;
  contentType?: string;
  fallbackExtension?: string;
}): string {
  const sourceName = input.name?.trim() || new URL(input.url).pathname.split("/").pop() || "asset";
  const extension =
    sourceName.includes(".") || !input.contentType
      ? ""
      : `.${extensionForContentType(input.contentType, input.fallbackExtension)}`;
  return `${sourceName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "asset"}${extension}`;
}

export function extensionForContentType(contentType: string, fallback = "bin"): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  return fallback;
}

export async function assertSafeAdMediaUrl(rawUrl: string): Promise<string> {
  return (await assertSafeOutboundUrl(rawUrl)).toString();
}

export async function downloadAdMedia(
  rawUrl: string,
  options: {
    maxBytes?: number;
    allowedContentTypes?: string[];
    fileName?: string;
  } = {},
): Promise<DownloadedAdMedia> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let currentUrl = await assertSafeAdMediaUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: { Accept: options.allowedContentTypes?.join(",") ?? "*/*" },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Media URL redirected without a Location header");
      currentUrl = await assertSafeAdMediaUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to download ad media (${response.status})`);
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() || "";
    if (
      options.allowedContentTypes?.length &&
      !options.allowedContentTypes.some((allowed) => contentType === allowed)
    ) {
      throw new Error(`Unsupported ad media content type: ${contentType || "unknown"}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      throw new Error(`Ad media exceeds maximum size of ${maxBytes} bytes`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Ad media exceeds maximum size of ${maxBytes} bytes`);
    }

    return {
      url: currentUrl,
      bytes,
      base64: Buffer.from(bytes).toString("base64"),
      contentType: contentType || "application/octet-stream",
      fileName:
        options.fileName ??
        mediaFileName({
          url: currentUrl,
          contentType: contentType || undefined,
        }),
    };
  }

  throw new Error("Too many redirects while downloading ad media");
}

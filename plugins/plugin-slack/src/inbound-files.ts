/**
 * Boundary mapping for Slack file objects on inbound messages and history reads.
 * Slack's Web API and Events API send `url_private` / `url_private_download`
 * (snake_case); the plugin's `SlackFile` and core `Media` are camelCase and
 * `Media.url` is required, so the raw object is normalized once here and a
 * file with no fetchable URL is dropped with a warning instead of becoming a
 * `Media` that no consumer can fetch.
 */
import {
  ElizaError,
  type FetchLike,
  fetchWithSsrfGuard,
  logger,
  type Media,
  readResponseWithLimit,
} from "@elizaos/core";
import type { SlackFile } from "./types";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize one Slack file object from the wire. Accepts the snake_case Web API
 * shape and, for callers that already hold a `SlackFile`, the camelCase shape.
 * Returns null when the object has no string `id`.
 */
export function normalizeSlackFile(raw: unknown): SlackFile | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Record<string, unknown>;
  const id = optionalString(file.id);
  if (!id) return null;
  const name = optionalString(file.name) ?? "";
  const size =
    typeof file.size === "number" && Number.isFinite(file.size) ? file.size : 0;
  return {
    id,
    name,
    title: optionalString(file.title) ?? name,
    mimetype: optionalString(file.mimetype) ?? "",
    filetype: optionalString(file.filetype) ?? "",
    size,
    urlPrivate:
      optionalString(file.url_private) ?? optionalString(file.urlPrivate) ?? "",
    urlPrivateDownload:
      optionalString(file.url_private_download) ??
      optionalString(file.urlPrivateDownload),
    permalink: optionalString(file.permalink) ?? "",
    thumb64: optionalString(file.thumb_64) ?? optionalString(file.thumb64),
    thumb80: optionalString(file.thumb_80) ?? optionalString(file.thumb80),
    thumb360: optionalString(file.thumb_360) ?? optionalString(file.thumb360),
  };
}

/** Normalize a raw `files` array; entries without an id are dropped. */
export function normalizeSlackFiles(raw: unknown): SlackFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: SlackFile[] = [];
  for (const entry of raw) {
    const file = normalizeSlackFile(entry);
    if (file) files.push(file);
  }
  return files;
}

/**
 * Build the `Media` attachments for a message. The download URL is preferred
 * because it always serves the bytes; `url_private` may serve a viewer page for
 * some file types. A file with neither URL is logged and omitted so the
 * attachment list never carries an unfetchable entry.
 */
export function slackFilesToMedia(
  files: readonly SlackFile[] | undefined,
  context: { channelId: string; messageTs: string },
): Media[] {
  const media: Media[] = [];
  for (const file of files ?? []) {
    const url = file.urlPrivateDownload || file.urlPrivate;
    if (!url) {
      logger.warn(
        {
          src: "plugin:slack:inbound-files",
          fileId: file.id,
          channelId: context.channelId,
          messageTs: context.messageTs,
        },
        "[SlackService] Inbound file has no url_private or url_private_download; attachment omitted",
      );
      continue;
    }
    media.push({
      id: file.id,
      url,
      title: file.title || file.name,
      source: "slack",
      description: file.name,
    });
  }
  return media;
}

const SLACK_FILE_HOSTS = new Set(["files.slack.com", "files.slack-gov.com"]);

export interface SlackFileBytes {
  buffer: Buffer;
  contentType: string | undefined;
}

export async function fetchSlackFileBytes(
  url: string,
  botToken: string,
  options: {
    maxBytes: number;
    expectedMimeType?: string;
    fetchImpl?: FetchLike;
  },
): Promise<SlackFileBytes> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !SLACK_FILE_HOSTS.has(parsed.hostname)) {
    throw new ElizaError("Slack file URL is not on a Slack file host", {
      code: "SLACK_FILE_HOST_UNTRUSTED",
      context: { host: parsed.hostname },
    });
  }
  const { response, release } = await fetchWithSsrfGuard({
    url,
    fetchImpl: options.fetchImpl,
    timeoutMs: 30_000,
    maxRedirects: 5,
    init: { headers: { Authorization: `Bearer ${botToken}` } },
  });
  try {
    if (!response.ok) {
      throw new ElizaError(
        `Slack file download failed with HTTP ${response.status}`,
        {
          code: "SLACK_FILE_DOWNLOAD_FAILED",
          context: { host: parsed.hostname, status: response.status },
        },
      );
    }
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    if (
      contentType === "text/html" &&
      options.expectedMimeType !== "text/html"
    ) {
      throw new ElizaError(
        "Slack returned an HTML page instead of file bytes; the bot token needs the files:read scope",
        {
          code: "SLACK_FILE_DOWNLOAD_UNAUTHORIZED",
          context: { host: parsed.hostname },
        },
      );
    }
    const buffer = await readResponseWithLimit(response, options.maxBytes);
    return { buffer, contentType };
  } finally {
    await release();
  }
}

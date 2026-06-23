/**
 * Shared connector attachment helpers — the canonical, connector-agnostic way to
 * (a) classify a platform attachment's MIME type into the coarse `ContentType`,
 * (b) build a normalized `Media` from a connector's raw attachment shape, and
 * (c) fetch attachment bytes safely (SSRF-guarded + size-capped).
 *
 * Every connector (Discord, Telegram, Slack, …) previously reimplemented these,
 * often inconsistently (some set no `contentType`, some fetched with a raw,
 * unguarded `fetch`). Connectors should import these instead. `contentTypeForMime`
 * returns the literal `ContentType` string values (not the enum object) so it has
 * no runtime dependency on the `ContentType` const and is safe to import from any
 * package/runtime.
 */

import { fetchRemoteMedia } from "../media/fetch";
import type { ContentType, Media } from "../types/primitives";

/** Default hard cap on bytes pulled when resolving a connector attachment. */
export const DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Map a platform attachment's MIME type to the coarse core `ContentType`.
 * Returns the literal value so callers never touch the `ContentType` enum object.
 */
export function contentTypeForMime(mime?: string | null): ContentType {
	const m = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	return "document";
}

/** A connector's raw attachment, before normalization to {@link Media}. */
export interface RawConnectorAttachment {
	/** Platform attachment id (used as Media.id when present). */
	id?: string | number;
	/** A servable/fetchable URL for the bytes. */
	url: string;
	/** Platform-reported MIME type, if any. */
	mimeType?: string | null;
	/** Original filename, if any. */
	fileName?: string | null;
	/** Byte size, if known. */
	size?: number | null;
	/** Optional human title / description / extracted text. */
	title?: string;
	description?: string;
	text?: string;
}

/**
 * Normalize a connector's raw attachment into a `Media`, deriving `contentType`
 * from the MIME type so audio/video are transcribed downstream and every
 * attachment round-trips safely across connectors. Pass a default index to mint
 * a stable id when the platform doesn't supply one.
 */
export function toMedia(
	raw: RawConnectorAttachment,
	opts?: { idFallback?: string },
): Media {
	const contentType = contentTypeForMime(raw.mimeType);
	const media: Media = {
		id: String(raw.id ?? opts?.idFallback ?? raw.url),
		url: raw.url,
		contentType,
	};
	if (raw.title) media.title = raw.title;
	if (raw.description) media.description = raw.description;
	if (raw.text) media.text = raw.text;
	if (raw.fileName) media.filename = raw.fileName;
	if (typeof raw.size === "number" && Number.isFinite(raw.size)) {
		media.size = raw.size;
	}
	if (raw.mimeType) media.mimeType = raw.mimeType.split(";")[0]?.trim();
	return media;
}

/** Bytes + resolved metadata for a connector attachment. */
export interface ResolvedAttachmentBytes {
	buffer: Buffer;
	contentType: string;
	fileName?: string;
}

/**
 * Fetch a remote connector attachment's bytes through the SSRF-guarded fetcher
 * (blocks private/loopback/link-local hosts) with a hard size cap. Use this for
 * any inbound/outbound connector media fetch instead of a raw `fetch`.
 */
export async function resolveAttachmentBytes(
	url: string,
	opts?: { maxBytes?: number },
): Promise<ResolvedAttachmentBytes> {
	const { buffer, contentType, fileName } = await fetchRemoteMedia({
		url,
		maxBytes: opts?.maxBytes ?? DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
	});
	return {
		buffer,
		contentType: contentType ?? "application/octet-stream",
		...(fileName ? { fileName } : {}),
	};
}

/**
 * Source links of saved items such as summary notes: a selected document (named by its exact
 * bytes and, on Android, an `a1:` reference that keeps the document's read grant), a web page or
 * a recording. Validators accept only bounded, well-formed descriptors and return a normalized
 * copy; anything else is not a link. A document link reopens only matching bytes; a web link
 * visits the current page, whose contents may have changed; a recording link names an exact
 * revision. Pure functions: no storage, network or platform access.
 */

/** Document types a source link may name. */
export const SOURCE_DOCUMENT_TYPES = [
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
/** Largest linked source document. */
export const SOURCE_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export type DocumentSourceLink = {
  version: 1;
  name: string;
  mimeType: string;
  sha256: string;
  size: number;
  /** `a1:` durable grant reference or `b1:` browser file identity. */
  reference?: string;
};
export type WebSourceLink = {
  kind: "web-page";
  version: 1;
  name: string;
  url: string;
};
export type RecordingSourceLink = {
  kind: "recording";
  version: 1;
  name: string;
  noteId: string;
  revision: string;
};
export type SummarySourceLink =
  | DocumentSourceLink
  | WebSourceLink
  | RecordingSourceLink;

/** True for C0 controls, DEL and any of the extra characters. */
const hasControl = (text: string, extra = ""): boolean => {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || extra.includes(character)) return true;
  }
  return false;
};
const label = (name: unknown): name is string =>
  typeof name === "string" &&
  !!name.trim() &&
  name.length <= 120 &&
  !hasControl(name);

export function documentSourceOf(
  value: unknown,
): DocumentSourceLink | undefined {
  const s = value as DocumentSourceLink | undefined;
  if (
    s?.version !== 1 ||
    typeof s.name !== "string" ||
    !s.name ||
    s.name.length > 120 ||
    hasControl(s.name, "\\/") ||
    typeof s.mimeType !== "string" ||
    !(SOURCE_DOCUMENT_TYPES as readonly string[]).includes(s.mimeType) ||
    typeof s.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(s.sha256) ||
    !Number.isSafeInteger(s.size) ||
    s.size < 0 ||
    s.size > SOURCE_DOCUMENT_MAX_BYTES
  )
    return;
  return {
    version: 1,
    name: s.name,
    mimeType: s.mimeType,
    sha256: s.sha256,
    size: s.size,
    ...(typeof s.reference === "string" &&
    /^(?:b1:[a-f0-9-]{36}|a1:[a-f0-9]{64})$/.test(s.reference)
      ? { reference: s.reference }
      : {}),
  };
}

export function recordingSourceOf(
  value: unknown,
): RecordingSourceLink | undefined {
  const s = value as RecordingSourceLink | undefined;
  if (
    s?.kind !== "recording" ||
    s.version !== 1 ||
    !label(s.name) ||
    typeof s.noteId !== "string" ||
    !s.noteId ||
    s.noteId.length > 128 ||
    hasControl(s.noteId) ||
    typeof s.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(s.revision)
  )
    return;
  return {
    kind: "recording",
    version: 1,
    name: s.name,
    noteId: s.noteId,
    revision: s.revision,
  };
}

/**
 * An HTTPS page link without credentials. `isSensitiveUrl` lets the host refuse addresses its
 * reading policy treats as sign-in, account or secret pages; such a page is never linked.
 */
export function webSourceOf(
  value: unknown,
  isSensitiveUrl: (url: string) => boolean = () => false,
): WebSourceLink | undefined {
  const s = value as WebSourceLink | undefined;
  if (
    s?.kind !== "web-page" ||
    s.version !== 1 ||
    !label(s.name) ||
    typeof s.url !== "string" ||
    s.url.length > 4096 ||
    hasControl(s.url, " ")
  )
    return;
  try {
    const url = new URL(s.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      isSensitiveUrl(url.href)
    )
      return;
    return { kind: "web-page", version: 1, name: s.name, url: url.href };
  } catch {
    return;
  }
}

export function summarySourceOf(
  value: unknown,
  isSensitiveUrl?: (url: string) => boolean,
): SummarySourceLink | undefined {
  return (
    recordingSourceOf(value) ||
    webSourceOf(value, isSensitiveUrl) ||
    documentSourceOf(value)
  );
}

/** Lowercase hexadecimal SHA-256 of a recording note's JSON, its exact revision. */
export async function recordingRevision(note: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(note)),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The durable `a1:` references that saved and restorable items still name. The native reference
 * store keeps exactly these (plus links retained within their grace period) and releases the rest.
 */
export function retainedSourceReferences(
  items: readonly unknown[],
  link: (item: unknown) => unknown = (item) =>
    (item as { documentSource?: unknown } | undefined)?.documentSource,
): string[] {
  return [
    ...new Set(
      items
        .map((item) => documentSourceOf(link(item))?.reference)
        .filter(
          (reference): reference is string =>
            !!reference && reference.startsWith("a1:"),
        ),
    ),
  ];
}

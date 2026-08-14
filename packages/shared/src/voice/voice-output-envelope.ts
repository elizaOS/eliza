import { sanitizeSpeechText } from "../spoken-text";

export type VoiceOutputPolicy = "say" | "show" | "both" | "never_speak";

export type VoiceArtifactKind =
  | "audio"
  | "code"
  | "data"
  | "file"
  | "image"
  | "link";

export interface VoiceArtifactReference {
  /** Stable opaque identity. Artifact bytes never travel in the voice frame. */
  id: string;
  kind: VoiceArtifactKind;
  label: string;
  mimeType?: string;
  href?: string;
}

/**
 * Provider-neutral semantic answer. `spoken` is intentionally separate from
 * exact display Markdown because speech cannot faithfully carry code, tables,
 * paths, links, or control payloads.
 */
export interface VoiceOutputEnvelope {
  policy: VoiceOutputPolicy;
  display: {
    markdown: string;
  };
  /** Explicit concise speech. Omit to use the conservative legacy projection. */
  spoken?: string;
  artifacts?: readonly VoiceArtifactReference[];
}

export type VoiceSpeechBlockReason =
  | "never_speak"
  | "show_only"
  | "sensitive_content"
  | "structured_speech"
  | "structured_requires_spoken"
  | "invalid_envelope"
  | "empty";

export interface VoiceOutputProjection {
  /** Exact display payload; never normalized or rewritten by speech policy. */
  displayMarkdown: string;
  showDisplay: boolean;
  /** Exact text handed to TTS, or null when speech is intentionally blocked. */
  speechText: string | null;
  /** Captions are derived from, and byte-equal to, the actual TTS projection. */
  captions: string | null;
  artifacts: readonly VoiceArtifactReference[];
  speechBlockReason?: VoiceSpeechBlockReason;
  usedStructuredSummary: boolean;
  truncated: boolean;
}

export interface VoiceOutputProjectionOptions {
  maxSpeechChars?: number;
}

const DEFAULT_MAX_SPEECH_CHARS = 600;
const MIN_MAX_SPEECH_CHARS = 40;
const MAX_MAX_SPEECH_CHARS = 2_000;

const SENSITIVE_SPEECH_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk[-_](?:car[-_]|ant[-_]|proj[-_]?)?|csk-|gsk_)[A-Za-z0-9_-]{12,}\b/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/i,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|private[_ -]?key|secret|password|passwd|pwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
];

function canonicalizeSensitiveText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

function containsSensitiveSpeech(text: string): boolean {
  const canonical = canonicalizeSensitiveText(text);
  const sanitized = sanitizeSpeechText(canonical);
  return [text, canonical, sanitized].some((candidate) =>
    SENSITIVE_SPEECH_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

type StructuredKind = "code" | "table" | "link" | "path" | "data";

function structuredKinds(markdown: string): Set<StructuredKind> {
  const kinds = new Set<StructuredKind>();
  if (
    /```|~~~|`[^`\n]*`|<\/?(?:code|pre)\b/i.test(markdown) ||
    /(?:^|\n)(?: {4}|\t)\S/.test(markdown) ||
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(markdown) ||
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.test(markdown) ||
    /\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+\w+\s*)?\{/.test(markdown) ||
    /\binterface\s+[A-Za-z_$][\w$]*\s*\{/.test(markdown) ||
    /\btype\s+[A-Za-z_$][\w$]*\s*=/.test(markdown) ||
    /\bimport\s+(?:[\w*{][\s\S]*?\s+from\s+|["'])/.test(markdown) ||
    /\bexport\s+(?:default\s+)?(?:const|let|var|function|class|\{)/.test(
      markdown,
    ) ||
    /\b(?:SELECT\b[\s\S]+\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]+\bSET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(
      markdown,
    ) ||
    /(?:^|\n)\s*(?:\$\s+|sudo\s+|bun\s+|npm\s+|pnpm\s+|yarn\s+|git\s+|curl\s+)\S/.test(
      markdown,
    )
  ) {
    kinds.add("code");
  }
  const lines = markdown.split(/\r?\n/);
  if (
    lines.some((line) => line.includes("|")) &&
    lines.some((line) =>
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line),
    )
  ) {
    kinds.add("table");
  }
  if (
    /\bhttps?:\/\/\S+/i.test(markdown) ||
    /\[[^\]]+\]\([^)]+\)/.test(markdown) ||
    /\[[^\]]+\]\[[^\]]*\]/.test(markdown) ||
    /^\s*\[[^\]]+\]:\s*\S+/m.test(markdown)
  ) {
    kinds.add("link");
  }
  if (
    /(?:^|[\s('"`])(?:~|\.{1,2})?[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+/.test(
      markdown,
    ) ||
    /\b[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+/.test(markdown) ||
    /(?:^|[\s('"`])(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+/u.test(markdown)
  ) {
    kinds.add("path");
  }
  if (
    /(?:^|\n)\s*(?:[-+*]|\d+[.)]|#{1,6}|>)\s+\S/.test(markdown) ||
    /(?:^|\n)\s*(?:\{|\[)[\s\S]*(?:\}|\])\s*$/.test(markdown) ||
    /(?:=>|:=|===|!==)/.test(markdown)
  ) {
    kinds.add("data");
  }
  return kinds;
}

function containsExplicitStructuredSpeech(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return (
    /```|~~~|`[^`\n]*`|<\/?(?:code|pre)\b/i.test(text) ||
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(text) ||
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.test(text) ||
    /\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+\w+\s*)?\{/.test(text) ||
    /\binterface\s+[A-Za-z_$][\w$]*\s*\{/.test(text) ||
    /\btype\s+[A-Za-z_$][\w$]*\s*=/.test(text) ||
    /\bSELECT\b[\s\S]+\bFROM\b/.test(text) ||
    /(?:^|[\s('"`])(?:~|\.{1,2})?[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+/.test(
      text,
    ) ||
    /\b[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+/.test(text) ||
    /(?:^|[\s('"`])(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+\.[A-Za-z0-9]{1,12}(?=\s|$|[.,;:!?])/u.test(
      text,
    ) ||
    /\bhttps?:\/\/\S+/i.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    (lines.some((line) => line.includes("|")) &&
      lines.some((line) =>
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line),
      ))
  );
}

function summarizeStructuredDisplay(
  kinds: ReadonlySet<StructuredKind>,
): string {
  if (kinds.size !== 1) {
    return "I've put the exact structured details on screen.";
  }
  if (kinds.has("code")) return "I've put the exact code on screen.";
  if (kinds.has("table")) return "I've put the table on screen.";
  if (kinds.has("link")) return "I've put the exact link on screen.";
  if (kinds.has("path")) return "I've put the exact path on screen.";
  return "I've put the structured data on screen.";
}

function boundedMaxSpeechChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_SPEECH_CHARS;
  }
  return Math.min(
    MAX_MAX_SPEECH_CHARS,
    Math.max(MIN_MAX_SPEECH_CHARS, Math.floor(value)),
  );
}

function truncateSpeech(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let prefix = text.slice(0, Math.max(1, maxChars - 1));
  if (/[\uD800-\uDBFF]$/.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  const sentenceEnd = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
  );
  const wordEnd = prefix.lastIndexOf(" ");
  const cut =
    sentenceEnd >= Math.floor(maxChars * 0.5) ? sentenceEnd + 1 : wordEnd;
  return {
    text: `${prefix.slice(0, cut > 0 ? cut : prefix.length).trimEnd()}…`,
    truncated: true,
  };
}

function validArtifacts(
  artifacts: readonly VoiceArtifactReference[] | undefined,
): readonly VoiceArtifactReference[] {
  if (!Array.isArray(artifacts)) return [];
  const validKinds = new Set<VoiceArtifactKind>([
    "audio",
    "code",
    "data",
    "file",
    "image",
    "link",
  ]);
  const safe: VoiceArtifactReference[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") continue;
    if (
      typeof artifact.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(artifact.id) ||
      typeof artifact.label !== "string" ||
      artifact.label.trim().length === 0 ||
      artifact.label.length > 200 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(artifact.label) ||
      !validKinds.has(artifact.kind)
    ) {
      continue;
    }
    if (
      artifact.mimeType !== undefined &&
      (typeof artifact.mimeType !== "string" ||
        !/^[\w.+-]+\/[\w.+-]{1,100}$/.test(artifact.mimeType))
    ) {
      continue;
    }
    if (
      artifact.href !== undefined &&
      (typeof artifact.href !== "string" ||
        artifact.href.length > 2_048 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(artifact.href) ||
        !/^(?:https?:\/\/|\/(?![\\/]))/i.test(artifact.href))
    ) {
      continue;
    }
    // Return immutable value copies so validated references cannot be mutated
    // into a different (for example javascript:) target after projection.
    safe.push(
      Object.freeze({
        id: artifact.id,
        kind: artifact.kind,
        label: artifact.label,
        ...(artifact.mimeType === undefined
          ? {}
          : { mimeType: artifact.mimeType }),
        ...(artifact.href === undefined ? {} : { href: artifact.href }),
      }),
    );
  }
  return Object.freeze(safe);
}

export function projectVoiceOutput(
  envelope: VoiceOutputEnvelope,
  options: VoiceOutputProjectionOptions = {},
): VoiceOutputProjection {
  const validPolicy = ["say", "show", "both", "never_speak"].includes(
    envelope?.policy,
  );
  const validDisplay = typeof envelope?.display?.markdown === "string";
  const validSpoken =
    envelope?.spoken === undefined || typeof envelope.spoken === "string";
  const displayMarkdown = validDisplay ? envelope.display.markdown : "";
  const artifacts = validArtifacts(envelope?.artifacts);
  const showDisplay = envelope?.policy !== "say";
  const blocked = (
    speechBlockReason: VoiceSpeechBlockReason,
  ): VoiceOutputProjection => ({
    displayMarkdown,
    showDisplay,
    speechText: null,
    captions: null,
    artifacts,
    speechBlockReason,
    usedStructuredSummary: false,
    truncated: false,
  });

  if (!validPolicy || !validDisplay || !validSpoken) {
    return blocked("invalid_envelope");
  }
  if (envelope.policy === "never_speak") return blocked("never_speak");
  if (envelope.policy === "show") return blocked("show_only");

  const rawCandidate = envelope.spoken?.trim();
  if (
    containsSensitiveSpeech(rawCandidate ?? "") ||
    (!rawCandidate && containsSensitiveSpeech(displayMarkdown))
  ) {
    return blocked("sensitive_content");
  }

  if (rawCandidate && containsExplicitStructuredSpeech(rawCandidate)) {
    return blocked("structured_speech");
  }

  const kinds = structuredKinds(displayMarkdown);
  const usedStructuredSummary = !rawCandidate && kinds.size > 0;
  if (usedStructuredSummary && !showDisplay) {
    return blocked("structured_requires_spoken");
  }
  const candidate = usedStructuredSummary
    ? summarizeStructuredDisplay(kinds)
    : (rawCandidate ?? displayMarkdown);
  const sanitized = sanitizeSpeechText(candidate);
  if (!sanitized) return blocked("empty");

  const projected = truncateSpeech(
    sanitized,
    boundedMaxSpeechChars(options.maxSpeechChars),
  );
  return {
    displayMarkdown,
    showDisplay,
    speechText: projected.text,
    captions: projected.text,
    artifacts,
    usedStructuredSummary,
    truncated: projected.truncated,
  };
}

/**
 * Builds deterministic parser fixtures and reproduces their normalized text.
 * Expected hashes and coordinates come from separately declared oracle text,
 * while verification re-runs the extractor against published bytes.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";

export type ProgressiveFormatKind =
  | "markdown"
  | "html"
  | "csv"
  | "jsonl"
  | "pdf-text"
  | "docx"
  | "mime-nested"
  | "ocr-required"
  | "extraction-failed";
export type ProgressiveExtractionState = "ready" | "ocr-required" | "failed";

export interface ProgressiveExtractedCanary {
  readonly text: string;
  readonly utf8ByteStart: number;
  readonly utf8ByteEnd: number;
}

export interface ProgressiveFormatFixture {
  readonly id: string;
  readonly kind: ProgressiveFormatKind;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly revision: string;
  readonly authorizationScope: string;
  readonly expectedState: ProgressiveExtractionState;
  readonly normalization: "elizaos.progressive-content.normalized-text.v1";
  readonly expectedTextSha256?: string;
  readonly expectedTextUtf8Bytes?: number;
  readonly canaries: readonly ProgressiveExtractedCanary[];
  readonly decoys: readonly ProgressiveExtractedCanary[];
}

export interface ProgressiveExtractionResult {
  readonly state: ProgressiveExtractionState;
  readonly normalizedText?: string;
  readonly reason?: string;
}

interface BuiltFixture {
  readonly kind: ProgressiveFormatKind;
  readonly extension: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly expectedState: ProgressiveExtractionState;
  readonly expectedText?: string;
  readonly canaryTexts: readonly string[];
  readonly decoyTexts: readonly string[];
}

const NORMALIZATION = "elizaos.progressive-content.normalized-text.v1" as const;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const normalizeLines = (value: string): string =>
  value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
const decodeXmlText = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

function extractHtml(bytes: Uint8Array): string {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return normalizeLines(
    decodeXmlText(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
        .replace(/<\/(?:p|h[1-6]|tr|table|div)>/giu, "\n")
        .replace(/<\/(?:td|th)>/giu, "\t")
        .replace(/<br\s*\/?>/giu, "\n")
        .replace(/<[^>]+>/gu, " ")
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n[ \t]+/gu, "\n")
        .replace(/[ \t]{2,}/gu, " ")
        .replace(/\n{2,}/gu, "\n"),
    ),
  );
}

function parseCsvRow(row: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += character;
  }
  if (quoted) throw new Error("unterminated CSV quote");
  values.push(value);
  return values;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unescapePdfLiteral(value: string): string {
  const replacements: Readonly<Record<string, string>> = {
    "\\": "\\",
    "(": "(",
    ")": ")",
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
  };
  return value.replace(
    /\\([\\()nrtbf])/gu,
    (_match, escaped: string) => replacements[escaped] ?? escaped,
  );
}

function extractPdfText(bytes: Uint8Array): ProgressiveExtractionResult {
  const source = Buffer.from(bytes).toString("latin1");
  const imageCount = source.match(/\/Subtype\s*\/Image\b/gu)?.length ?? 0;
  const text = [...source.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj\b/gu)]
    .map((match) => unescapePdfLiteral(match[1] ?? ""))
    .join("\n");
  if (!text.trim() && imageCount > 0)
    return { state: "ocr-required", reason: "image-only PDF" };
  if (!text.trim())
    return { state: "failed", reason: "PDF has no extractable text" };
  return { state: "ready", normalizedText: normalizeLines(text) };
}

function extractDocx(bytes: Uint8Array): string {
  const document = unzipSync(bytes)["word/document.xml"];
  if (!document) throw new Error("DOCX is missing word/document.xml");
  const xml = new TextDecoder("utf-8", { fatal: true })
    .decode(document)
    .replace(/<w:tab\s*\/>/gu, "\t")
    .replace(/<w:br\s*\/>/gu, "\n")
    .replace(/<\/w:tc>/gu, "\t")
    .replace(/<\/w:p>/gu, "\n");
  const pieces = [
    ...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|([\n\t])/gu),
  ]
    .map((match) =>
      match[1] === undefined ? match[2] : decodeXmlText(match[1]),
    )
    .join("");
  return normalizeLines(
    pieces
      .replace(/\t+\n/gu, "\n")
      .replace(/\n\t+/gu, "\n")
      .replace(/\n{2,}/gu, "\n"),
  );
}

interface MimePart {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
function parseHeaders(source: string): Readonly<Record<string, string>> {
  const unfolded = source.replace(/\r?\n[ \t]+/gu, " ");
  return Object.fromEntries(
    unfolded.split(/\r?\n/gu).flatMap((line) => {
      const colon = line.indexOf(":");
      return colon < 1
        ? []
        : [[line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]];
    }),
  );
}
function splitMime(source: string): MimePart {
  const separator = source.match(/\r?\n\r?\n/u);
  if (!separator || separator.index === undefined)
    throw new Error("MIME part has no header separator");
  return {
    headers: parseHeaders(source.slice(0, separator.index)),
    body: source.slice(separator.index + separator[0].length),
  };
}
function decodeTransfer(body: string, encoding: string): string {
  const trimmed = body.replace(/\r?\n$/u, "");
  if (encoding.toLowerCase() === "base64")
    return Buffer.from(trimmed.replace(/\s/gu, ""), "base64").toString("utf8");
  if (encoding.toLowerCase() === "quoted-printable")
    return trimmed
      .replace(/=\r?\n/gu, "")
      .replace(/=([0-9A-F]{2})/giu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  return trimmed;
}
function collectMimeText(source: string): string[] {
  const part = splitMime(source);
  const contentType = part.headers["content-type"] ?? "text/plain";
  if (/attachment/iu.test(part.headers["content-disposition"] ?? "")) return [];
  if (/^multipart\//iu.test(contentType)) {
    const boundary = contentType
      .match(/boundary=(?:"([^"]+)"|([^;\s]+))/iu)
      ?.slice(1)
      .find(Boolean);
    if (!boundary) throw new Error("multipart MIME part has no boundary");
    return part.body
      .split(`--${boundary}`)
      .slice(1)
      .filter((child) => !child.startsWith("--"))
      .flatMap((child) => collectMimeText(child.replace(/^\r?\n/u, "")));
  }
  const decoded = decodeTransfer(
    part.body,
    part.headers["content-transfer-encoding"] ?? "",
  );
  return /^text\/plain/iu.test(contentType) ? [normalizeLines(decoded)] : [];
}

/** Reproduce normalized text/state from published fixture bytes. */
export function extractProgressiveFormatFixture(
  kind: ProgressiveFormatKind,
  bytes: Uint8Array,
): ProgressiveExtractionResult {
  try {
    if (kind === "ocr-required" || kind === "pdf-text")
      return extractPdfText(bytes);
    if (kind === "extraction-failed")
      return { state: "failed", reason: "unsupported binary format" };
    if (kind === "docx")
      return { state: "ready", normalizedText: extractDocx(bytes) };
    if (kind === "mime-nested")
      return {
        state: "ready",
        normalizedText: normalizeLines(
          collectMimeText(Buffer.from(bytes).toString("utf8")).join("\n"),
        ),
      };
    if (kind === "html")
      return { state: "ready", normalizedText: extractHtml(bytes) };
    if (kind === "csv") {
      const source = normalizeLines(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      return {
        state: "ready",
        normalizedText: source
          .split("\n")
          .map((row) => parseCsvRow(row).join("\t"))
          .join("\n"),
      };
    }
    if (kind === "jsonl") {
      const source = normalizeLines(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      return {
        state: "ready",
        normalizedText: source
          .split("\n")
          .map((line) => canonicalJson(JSON.parse(line)))
          .join("\n"),
      };
    }
    return {
      state: "ready",
      normalizedText: normalizeLines(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ),
    };
  } catch (error) {
    return {
      state: "failed",
      reason: error instanceof Error ? error.message : "extraction failed",
    };
  }
}

function pdfEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}
function serializePdf(objects: readonly string[]): Uint8Array {
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    output += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
function buildPdf(pages: readonly string[]): Uint8Array {
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  for (const [index, page] of pages.entries()) {
    const contentId = (pageIds[index] as number) + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${pdfEscape(page)}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  return serializePdf(objects);
}
function buildImageOnlyPdf(): Uint8Array {
  const pixels = Buffer.from(
    Array.from(
      { length: 64 },
      (_, index) => ((index + Math.floor(index / 8)) % 2) * 255,
    ),
  );
  const encodedPixels = `${pixels.toString("hex")}>`;
  const image = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${encodedPixels.length} >>\nstream\n${encodedPixels}\nendstream`;
  const content = "q 256 0 0 256 72 400 cm /Im0 Do Q";
  return serializePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    image,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}
function buildDocx(): Uint8Array {
  const document =
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Evidence heading</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>DECOY-DOCX-46</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CANARY-DOCX-END-96</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(document),
    },
    { level: 6, mtime: new Date("2026-01-01T00:00:00.000Z") },
  );
}

function canaryCoordinates(
  text: string,
  canaries: readonly string[],
): ProgressiveExtractedCanary[] {
  return canaries.map((canary) => {
    const characterStart = text.indexOf(canary);
    if (characterStart < 0)
      throw new Error(`fixture oracle is missing canary: ${canary}`);
    const utf8ByteStart = Buffer.byteLength(text.slice(0, characterStart));
    return {
      text: canary,
      utf8ByteStart,
      utf8ByteEnd: utf8ByteStart + Buffer.byteLength(canary),
    };
  });
}

function buildFixtures(rootSeed: string): readonly BuiltFixture[] {
  const id = (kind: ProgressiveFormatKind) =>
    sha256(`progressive-format:${rootSeed}:${kind}`).slice(0, 24);
  const boundary = `eliza-${id("mime-nested")}`;
  const markdown =
    "# Early heading\n\nDECOY-MD-41\n\n## Final evidence\nCANARY-MD-END-91";
  const html = "Early\nDECOY-HTML-42\nanswer\nCANARY-HTML-TABLE-92";
  const csv = "row\tvalue\n1\tDECOY-CSV-43\n5000\tCANARY-CSV-END-93";
  const jsonl =
    '{"row":1,"value":"DECOY-JSONL-44"}\n{"row":5000,"value":"CANARY-JSONL-END-94"}';
  const pdf = "DECOY-PDF-EARLY-45\nmiddle page\nCANARY-PDF-LAST-95";
  const docx = "Evidence heading\nDECOY-DOCX-46\nCANARY-DOCX-END-96";
  const mime = "DECOY-MIME-47 quoted history\nCANARY-MIME-LATE-97";
  return [
    {
      kind: "markdown",
      extension: "md",
      mimeType: "text/markdown",
      bytes: Buffer.from(`${markdown}\n`),
      expectedState: "ready",
      expectedText: markdown,
      canaryTexts: ["CANARY-MD-END-91"],
      decoyTexts: ["DECOY-MD-41"],
    },
    {
      kind: "html",
      extension: "html",
      mimeType: "text/html",
      bytes: Buffer.from(
        "<!doctype html><html><body><h1>Early</h1><p>DECOY-HTML-42</p><table><tr><th>answer</th></tr><tr><td>CANARY-HTML-TABLE-92</td></tr></table><script>CANARY-SCRIPT-DECOY</script></body></html>",
      ),
      expectedState: "ready",
      expectedText: html,
      canaryTexts: ["CANARY-HTML-TABLE-92"],
      decoyTexts: ["DECOY-HTML-42"],
    },
    {
      kind: "csv",
      extension: "csv",
      mimeType: "text/csv",
      bytes: Buffer.from(
        'row,value\n1,"DECOY-CSV-43"\n5000,"CANARY-CSV-END-93"\n',
      ),
      expectedState: "ready",
      expectedText: csv,
      canaryTexts: ["CANARY-CSV-END-93"],
      decoyTexts: ["DECOY-CSV-43"],
    },
    {
      kind: "jsonl",
      extension: "jsonl",
      mimeType: "application/x-ndjson",
      bytes: Buffer.from(
        '{"value":"DECOY-JSONL-44","row":1}\n{"value":"CANARY-JSONL-END-94","row":5000}\n',
      ),
      expectedState: "ready",
      expectedText: jsonl,
      canaryTexts: ["CANARY-JSONL-END-94"],
      decoyTexts: ["DECOY-JSONL-44"],
    },
    {
      kind: "pdf-text",
      extension: "pdf",
      mimeType: "application/pdf",
      bytes: buildPdf(pdf.split("\n")),
      expectedState: "ready",
      expectedText: pdf,
      canaryTexts: ["CANARY-PDF-LAST-95"],
      decoyTexts: ["DECOY-PDF-EARLY-45"],
    },
    {
      kind: "docx",
      extension: "docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: buildDocx(),
      expectedState: "ready",
      expectedText: docx,
      canaryTexts: ["CANARY-DOCX-END-96"],
      decoyTexts: ["DECOY-DOCX-46"],
    },
    {
      kind: "mime-nested",
      extension: "eml",
      mimeType: "message/rfc822",
      bytes: Buffer.from(
        `From: =?UTF-8?B?5LiW55WM?= <sender@example.test>\r\nTo: owner@example.test\r\nSubject: nested evidence\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: multipart/alternative; boundary="alt-${boundary}"\r\n\r\n--alt-${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nDECOY-MIME-47 quoted history=0A=\r\nCANARY-MIME-LATE-97\r\n--alt-${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>alternate copy</p>\r\n--alt-${boundary}--\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="evidence.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nQ0FOQVJZLUFUVEFDSE1FTlQtREVDT1k=\r\n--${boundary}--\r\n`,
      ),
      expectedState: "ready",
      expectedText: mime,
      canaryTexts: ["CANARY-MIME-LATE-97"],
      decoyTexts: ["DECOY-MIME-47"],
    },
    {
      kind: "ocr-required",
      extension: "pdf",
      mimeType: "application/pdf",
      bytes: buildImageOnlyPdf(),
      expectedState: "ocr-required",
      canaryTexts: [],
      decoyTexts: [],
    },
    {
      kind: "extraction-failed",
      extension: "bin",
      mimeType: "application/octet-stream",
      bytes: Uint8Array.from([0, 255, 0, 254, 1, 2, 3]),
      expectedState: "failed",
      canaryTexts: [],
      decoyTexts: [],
    },
  ];
}

export interface ProgressiveFormatFixtureOracle {
  readonly bytes: Uint8Array;
  readonly declaration: ProgressiveFormatFixture;
}

/** Derive trusted fixture bytes and declarations from code plus the root seed. */
export function buildProgressiveFormatFixtureOracles(
  rootSeed: string,
): readonly ProgressiveFormatFixtureOracle[] {
  return buildFixtures(rootSeed).map((fixture) => {
    const id = sha256(`progressive-format:${rootSeed}:${fixture.kind}`).slice(
      0,
      24,
    );
    const relativePath = path.posix.join(
      "formats",
      `${id}.${fixture.extension}`,
    );
    const extraction = extractProgressiveFormatFixture(
      fixture.kind,
      fixture.bytes,
    );
    if (
      extraction.state !== fixture.expectedState ||
      extraction.normalizedText !== fixture.expectedText
    )
      throw new Error(
        `fixture ${fixture.kind} does not reproduce its declared oracle`,
      );
    const sourceSha256 = sha256(fixture.bytes);
    return {
      bytes: fixture.bytes,
      declaration: {
        id,
        kind: fixture.kind,
        relativePath,
        mimeType: fixture.mimeType,
        byteLength: fixture.bytes.byteLength,
        sourceSha256,
        revision: sourceSha256,
        authorizationScope: `fixture:${sha256(`${rootSeed}:${fixture.kind}`).slice(0, 16)}`,
        expectedState: fixture.expectedState,
        normalization: NORMALIZATION,
        ...(fixture.expectedText === undefined
          ? {}
          : {
              expectedTextSha256: sha256(fixture.expectedText),
              expectedTextUtf8Bytes: Buffer.byteLength(fixture.expectedText),
            }),
        canaries:
          fixture.expectedText === undefined
            ? []
            : canaryCoordinates(fixture.expectedText, fixture.canaryTexts),
        decoys:
          fixture.expectedText === undefined
            ? []
            : canaryCoordinates(fixture.expectedText, fixture.decoyTexts),
      },
    };
  });
}

/** Build and publish fixtures through the caller's hardened file boundary. */
export async function generateProgressiveFormatFixtures(options: {
  readonly rootSeed: string;
  readonly publish: (relativePath: string, bytes: Uint8Array) => Promise<void>;
}): Promise<readonly ProgressiveFormatFixture[]> {
  const fixtures: ProgressiveFormatFixture[] = [];
  for (const oracle of buildProgressiveFormatFixtureOracles(options.rootSeed)) {
    await options.publish(oracle.declaration.relativePath, oracle.bytes);
    fixtures.push(oracle.declaration);
  }
  return fixtures;
}

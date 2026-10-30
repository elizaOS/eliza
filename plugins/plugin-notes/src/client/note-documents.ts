/**
 * Owner-chosen document import and export for Notes. A host supplies a {@link NoteDocumentsPort}
 * (for example Android's document picker); {@link createBrowserNoteDocuments} is the browser
 * implementation: a local file input for import and a download for export. Nothing is uploaded,
 * and an export is only "requested": the browser does not confirm where the bytes landed.
 */

export interface NoteDocumentResult {
  /** `read`, `requested`, `exported`, `unverified`, `cancelled`, `failed`, `unavailable`, `unsupported` or `too-large`. */
  status: string;
  message: string;
  name?: string;
  text?: string;
  bytes?: number;
}
export interface NoteDocumentsPort {
  importText(): Promise<NoteDocumentResult>;
  exportText(input: {
    title: string;
    text: string;
  }): Promise<NoteDocumentResult>;
  exportPdf(input: {
    title: string;
    dataBase64: string;
  }): Promise<NoteDocumentResult>;
}

/** Largest text file the browser imports. */
export const NOTE_IMPORT_LIMIT = 2 * 1024 * 1024;
/** Largest generated PDF a host exports. */
export const NOTE_PDF_LIMIT = 8 * 1024 * 1024;
/** Largest base64 payload of a {@link NOTE_PDF_LIMIT} PDF. */
export const NOTE_PDF_BASE64_LIMIT = 11184812;

const UNSAFE_NAME = new Set('<>:"/\\|?*');
const unsafeNameChar = (char: string) =>
  UNSAFE_NAME.has(char) || char.charCodeAt(0) <= 0x1f;

/** A download file name: unsafe characters become `_`, cut to `max`, blank falls back. */
export function noteDocumentFileName(
  title: unknown,
  fallback: string,
  max: number,
): string {
  let name = "";
  for (const char of String(title ?? ""))
    name += unsafeNameChar(char) ? "_" : char;
  return name.slice(0, max) || fallback;
}

/** Decodes a bounded base64 PDF that starts with the PDF signature, or throws. */
export function notePdfBytes(dataBase64: unknown): Uint8Array {
  if (
    typeof dataBase64 !== "string" ||
    !dataBase64.length ||
    dataBase64.length > NOTE_PDF_BASE64_LIMIT ||
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
  )
    throw Error("Invalid PDF export.");
  const raw = atob(dataBase64);
  if (raw.length > NOTE_PDF_LIMIT || !raw.startsWith("%PDF-"))
    throw Error("Invalid PDF export.");
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Strict UTF-8 text with no NUL, or throws. */
export function noteImportText(bytes: ArrayBuffer): string {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (text.includes("\0")) throw Error("Binary file");
  return text;
}

export interface BrowserNoteDocumentsOptions {
  /** File name used when a PDF title is blank. */
  pdfFallback?: string;
  /** File name used when a note title is blank. */
  textFallback?: string;
  /** Revoke a download URL after this many milliseconds. */
  revokeAfterMs?: number;
}

/** User-selected local text and browser downloads only. The browser never uploads the chosen file. */
export function createBrowserNoteDocuments(
  options: BrowserNoteDocumentsOptions = {},
): NoteDocumentsPort {
  const pdfFallback = options.pdfFallback ?? "Scan";
  const textFallback = options.textFallback ?? "Note";
  const revokeAfter = options.revokeAfterMs ?? 60_000;
  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), revokeAfter);
    }
  };
  return {
    importText() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".txt,.md,.markdown,text/plain,text/markdown";
        input.hidden = true;
        document.body.append(input);
        let settled = false;
        const finish = (result: NoteDocumentResult) => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(result);
        };
        input.addEventListener(
          "cancel",
          () => finish({ status: "cancelled", message: "No file imported." }),
          { once: true },
        );
        input.addEventListener(
          "change",
          async () => {
            const file = input.files?.[0];
            if (!file)
              return finish({
                status: "cancelled",
                message: "No file imported.",
              });
            if (file.size > NOTE_IMPORT_LIMIT)
              return finish({
                status: "failed",
                message: "Choose a text file smaller than 2 MB.",
              });
            try {
              const text = noteImportText(await file.arrayBuffer());
              finish({
                status: "read",
                message: "Local text selected.",
                name: file.name,
                text,
              });
            } catch {
              finish({
                status: "failed",
                message: "Choose a valid UTF-8 text file. Nothing imported.",
              });
            }
          },
          { once: true },
        );
        input.click();
      });
    },
    async exportPdf({ title, dataBase64 }) {
      const bytes = notePdfBytes(dataBase64);
      download(
        new Blob([bytes as BlobPart], { type: "application/pdf" }),
        `${noteDocumentFileName(title, pdfFallback, 100)}.pdf`,
      );
      return {
        status: "requested",
        message: "PDF download requested. Check your browser downloads.",
      };
    },
    async exportText({ title, text }) {
      download(
        new Blob([text], { type: "text/plain;charset=utf-8" }),
        `${noteDocumentFileName(title, textFallback, 160)}.txt`,
      );
      return {
        status: "requested",
        message: "Download requested. Check your browser downloads.",
      };
    },
  };
}

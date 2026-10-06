import { BillHostError } from "./errors.mjs";

const unavailable = () => new BillHostError("Bill PDF extraction unavailable");

/** Unknown formats must remain incomplete unless a reviewed product policy excludes them. */
export const pdfBillAttachmentPolicy = (attachment) =>
  attachment?.mimeType === "application/pdf" ? "read" : "unsupported";

/** Eliza owns complete rendering/transcription; the product owns bill interpretation.
 * mapDocument receives every page, rather than flattened duplicate native/vision text.
 * Its result is subsequently validated against the task's bill/account scope by discovery.
 */
export function createPdfBillParser({ pdfService, mapDocument }) {
  if (
    typeof pdfService?.extractCompleteDocument !== "function" ||
    typeof mapDocument !== "function"
  )
    throw unavailable();
  return async (attachment, context, control) => {
    if (
      typeof control?.assertActive !== "function" ||
      attachment?.mimeType !== "application/pdf" ||
      !(attachment.data instanceof Uint8Array)
    )
      throw unavailable();
    const { assertActive, signal } = control;
    await assertActive();
    const document = await pdfService.extractCompleteDocument(attachment.data, {
      assertActive,
      signal,
    });
    await assertActive();
    if (
      document?.complete !== true ||
      !Number.isSafeInteger(document.pageCount) ||
      document.pageCount < 1 ||
      !Array.isArray(document.pages) ||
      document.pages.length !== document.pageCount
    )
      throw unavailable();
    for (const [index, page] of document.pages.entries()) {
      if (
        page.pageNumber !== index + 1 ||
        !["blank", "native+vision", "vision"].includes(page.method) ||
        typeof page.nativeText !== "string" ||
        typeof page.visionText !== "string" ||
        !page.visionText.trim()
      )
        throw unavailable();
    }
    // The interpreter may use a model; it must use this check before any external work.
    const parsed = await mapDocument(
      document,
      context,
      Object.freeze({ assertActive, signal }),
    );
    await assertActive();
    return parsed;
  };
}

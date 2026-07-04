/**
 * Browser stub for the `unpdf` package: PDF text extraction and document-proxy
 * access are Node-only, so the app bundle aliases the module to these throwing
 * placeholders rather than pulling the PDF engine into the renderer.
 */
export async function extractText(): Promise<{ text: string }> {
  throw new Error(
    "PDF text extraction is unavailable in the browser renderer.",
  );
}

export async function getDocumentProxy(): Promise<never> {
  throw new Error("PDF document proxy is unavailable in the browser renderer.");
}

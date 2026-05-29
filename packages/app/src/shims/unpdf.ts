export async function extractText(): Promise<{ text: string }> {
  throw new Error(
    "PDF text extraction is unavailable in the browser renderer.",
  );
}

export async function getDocumentProxy(): Promise<never> {
  throw new Error("PDF document proxy is unavailable in the browser renderer.");
}

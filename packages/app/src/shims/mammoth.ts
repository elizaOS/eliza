/**
 * Browser-bundle shim aliased in place of `mammoth` (DOCX-to-text). The library
 * depends on Node-only facilities, so the renderer stub keeps the `extractRawText`
 * signature but always rejects, forcing document extraction onto the backend
 * instead of failing at bundle time.
 */
export async function extractRawText(): Promise<{ value: string }> {
  throw new Error("DOCX extraction is unavailable in the browser renderer.");
}

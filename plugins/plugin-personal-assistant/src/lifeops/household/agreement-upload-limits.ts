/**
 * Defines the parenting-agreement upload limits shared by the HTTP boundary
 * and browser UI. The JSON allowance accounts for base64 expansion of one
 * maximum-size PDF plus bounded contract metadata.
 */

export const MAX_AGREEMENT_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_AGREEMENT_UPLOAD_JSON_BYTES = 28 * 1024 * 1024;

export function agreementUploadSizeMessage(): string {
  return "Agreement PDF must be 20 MiB or smaller.";
}

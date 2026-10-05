export type MailAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
};
export async function reviewMailAttachment(file: MailAttachment) {
  if (
    !file ||
    typeof file.name !== "string" ||
    file.name.length > 120 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted input.
    /[\\/\x00-\x1f\x7f]/.test(file.name) ||
    typeof file.dataBase64 !== "string" ||
    file.dataBase64.length > 7 * 1024 * 1024
  )
    throw new Error("Invalid attachment name or encoding");
  const raw = atob(file.dataBase64);
  if (btoa(raw) !== file.dataBase64 || raw.length > 5 * 1024 * 1024)
    throw new Error("Attachment exceeds 5 MiB");
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  let text: string | undefined;
  const name = file.name.toLowerCase();
  let valid = false;
  if (file.mimeType === "text/plain") {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
    valid = name.endsWith(".txt") && !text.includes("\0");
  }
  if (file.mimeType === "application/pdf")
    valid = name.endsWith(".pdf") && raw.startsWith("%PDF-");
  if (file.mimeType === "image/png")
    valid = name.endsWith(".png") && raw.startsWith("\x89PNG\r\n\x1a\n");
  if (file.mimeType === "image/jpeg")
    valid = /\.jpe?g$/.test(name) && raw.startsWith("\xff\xd8\xff");
  if (file.mimeType === "image/webp")
    valid =
      name.endsWith(".webp") &&
      raw.startsWith("RIFF") &&
      raw.slice(8, 12) === "WEBP";
  if (!valid)
    throw new Error(
      "Supported attachments: PDF, PNG, JPEG, WebP and UTF-8 TXT up to 5 MiB. File content must match its type.",
    );
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    name: file.name,
    mimeType: file.mimeType,
    size: bytes.length,
    sha256,
    ...(text === undefined ? {} : { text }),
  };
}

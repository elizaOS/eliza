/**
 * Decodes an HTTP text body with the charset its Content-Type names.
 * `Response.text()` and a bare `TextDecoder` always read UTF-8, which garbles
 * ISO-8859-1, windows-1252 and Shift_JIS pages. No or unknown label: UTF-8.
 */
export function decodeHttpText(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const label = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    // error-policy:J3 an unsupported charset label keeps the UTF-8 reading.
    return new TextDecoder().decode(bytes);
  }
}

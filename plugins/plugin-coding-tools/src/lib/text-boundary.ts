/** Exact CR/LF suffix; "none" means neither. Never normalizes content. */
export function finalLineEnding(text: string): "none" | "LF" | "CRLF" | "CR" {
  if (text.endsWith("\r\n")) return "CRLF";
  if (text.endsWith("\n")) return "LF";
  if (text.endsWith("\r")) return "CR";
  return "none";
}

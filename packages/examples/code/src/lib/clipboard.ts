/**
 * Build an OSC 52 terminal escape that copies `text` to the system clipboard.
 *
 * OSC 52 lets a program set the clipboard through the terminal itself, so it
 * works over SSH / inside the cockpit PTY where there's no direct clipboard
 * access. Format: `ESC ] 52 ; c ; <base64> BEL` — `c` is the clipboard
 * selection, the payload is base64-encoded UTF-8. Terminals that don't support
 * OSC 52 (or have it disabled) simply ignore the sequence.
 */
export function osc52(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

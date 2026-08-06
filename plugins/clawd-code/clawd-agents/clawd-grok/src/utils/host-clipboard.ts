import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Put plain text on the OS clipboard (OpenCode-style fallback when OSC 52 is not enough).
 */
export function copyTextToHostClipboard(text: string): void {
  const platform = os.platform();

  if (platform === "darwin") {
    const r = spawnSync("pbcopy", [], { input: text });
    if (r.status === 0) return;
  }

  if (platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) {
      const w = spawnSync("wl-copy", [], { input: text });
      if (w.status === 0) return;
    }
    const x = spawnSync("xclip", ["-selection", "clipboard"], { input: text });
    if (x.status === 0) return;
    const s = spawnSync("xsel", ["--clipboard", "--input"], { input: text });
    if (s.status === 0) return;
  }

  if (platform === "win32") {
    const clip = spawnSync("clip", [], { input: text });
    if (clip.status === 0) return;
  }
}

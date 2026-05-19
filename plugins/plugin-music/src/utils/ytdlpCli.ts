import { basename, dirname } from "node:path";

/**
 * yt-dlp YouTube "n challenge" / EJS solving needs a JS engine. Official builds only
 * enable **deno** by default; Eliza usually runs under **Bun** or **Node**, which must
 * be passed explicitly via `--js-runtimes`.
 *
 * @see https://github.com/yt-dlp/yt-dlp/wiki/EJS
 *
 * Override: comma-separated `RUNTIME[:PATH]` values, e.g.
 * `YTDLP_JS_RUNTIMES=bun:/opt/homebrew/bin,node:/usr/local/bin`
 * Disable auto-detection: `YTDLP_JS_RUNTIMES=off`
 */
export function getYtdlpJsRuntimeCliArgs(): string[] {
  const out: string[] = [];
  const envRaw = process.env.YTDLP_JS_RUNTIMES?.trim();
  if (envRaw) {
    const lower = envRaw.toLowerCase();
    if (
      lower === "off" ||
      lower === "none" ||
      lower === "0" ||
      lower === "false"
    ) {
      return out;
    }
    for (const part of envRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      out.push("--js-runtimes", part);
    }
    return out;
  }

  const execPath = process.execPath;
  const name = basename(execPath).toLowerCase();
  if (name === "bun" || name === "bun.exe") {
    out.push("--js-runtimes", `bun:${dirname(execPath)}`);
    return out;
  }
  if (name === "node" || name === "node.exe") {
    out.push("--js-runtimes", `node:${dirname(execPath)}`);
    return out;
  }
  return out;
}

function shellDoubleQuote(s: string): string {
  if (!/[\s\\"'$`!]/.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Fragment to append after the yt-dlp binary path in shell `exec()` strings. */
export function getYtdlpJsRuntimeShellFragment(): string {
  const pairs = getYtdlpJsRuntimeCliArgs();
  if (pairs.length === 0) {
    return "";
  }
  let s = "";
  for (let i = 0; i < pairs.length - 1; i += 2) {
    const flag = pairs[i];
    const val = pairs[i + 1];
    if (flag === undefined || val === undefined) {
      break;
    }
    s += ` ${flag} ${shellDoubleQuote(val)}`;
  }
  return s;
}

/**
 * Backend log capture for UI harnesses that run against a live dev stack.
 *
 * Pulls the aggregated vite/api/electrobun tail from the loopback dev
 * observability endpoint (`GET /api/dev/console-log`) and writes it as a
 * durable artifact, so a UI e2e flow can attach "real backend logs showing the
 * code path" per the PR_EVIDENCE convention — without bespoke tailing.
 *
 * It is best-effort: the endpoint is loopback-only and requires the desktop
 * dev log to be configured (`dev:desktop`). When it isn't available the helper
 * resolves to `{ ok: false, reason }` instead of throwing, so a component-only
 * test run (no live API) degrades cleanly.
 *
 * Usage:
 *   const res = await captureBackendLogs({
 *     apiBase: "http://127.0.0.1:31337",
 *     token: process.env.ELIZA_API_TOKEN,
 *     out: ".github/issue-evidence/1234-backend-logs.txt",
 *     grep: /MessageService|ActionRouter/,
 *   });
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @param {{ apiBase: string, token?: string, out?: string, maxLines?: number,
 *           maxBytes?: number, grep?: RegExp }} opts
 */
export async function captureBackendLogs(opts) {
  const {
    apiBase,
    token,
    out,
    maxLines = 800,
    maxBytes = 512000,
    grep,
  } = opts;
  if (!apiBase) return { ok: false, reason: "no apiBase" };

  const url = new URL("/api/dev/console-log", apiBase);
  url.searchParams.set("maxLines", String(maxLines));
  url.searchParams.set("maxBytes", String(maxBytes));

  let resp;
  try {
    resp = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${err?.message ?? err}` };
  }
  if (!resp.ok) {
    return { ok: false, reason: `HTTP ${resp.status}` };
  }

  const contentType = resp.headers.get("content-type") || "";
  let text = await resp.text();
  // The endpoint may return JSON ({lines|text}) or a raw text/plain tail.
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(text);
      text = Array.isArray(json.lines)
        ? json.lines.join("\n")
        : (json.text ?? text);
    } catch {
      /* keep raw text */
    }
  }
  if (grep) {
    text = text
      .split("\n")
      .filter((line) => grep.test(line))
      .join("\n");
  }

  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
  }
  return { ok: true, bytes: text.length, lines: text.split("\n").length, out };
}

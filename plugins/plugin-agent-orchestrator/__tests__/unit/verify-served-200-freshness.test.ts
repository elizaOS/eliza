/**
 * GAP-C regression: a static app that exists, is non-empty, and serves HTTP
 * 200 must NOT be marked "dead" just because its local file mtime predates the
 * session. Deploy steps that copy a build into place preserve the source
 * file's mtime, so the wall-clock freshness gate in `verifyLocalTarget` used to
 * false-positive on a healthy served app. That false-dead spuriously
 * suppressed round-1 task_complete and withheld the real diff from
 * "what did you change?".
 *
 * The live HTTP 200 probe is authoritative for a served URL, so the
 * mtime-freshness check must not override it. These tests pin that contract
 * with a real loopback HTTP server.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  annotateUnverifiedUrls,
  type RouteUrlVerification,
} from "../../src/services/sub-agent-router.js";

const HTML = "<!doctype html><title>color pop</title><h1>color pop</h1>";

// A "deploy-copy" mtime: the build files landed on disk well BEFORE the
// current session started (more than the 5s freshness slack).
const OLD_MTIME_S = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour ago

describe("verify: served 200 vs mtime freshness (GAP-C)", () => {
  let workdir: string;
  let server: Server;
  let port: number;
  let serve200 = true;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), "gapc-verify-"));
    const appDir = join(workdir, "color-pop");
    mkdirSync(appDir, { recursive: true });
    const indexPath = join(appDir, "index.html");
    writeFileSync(indexPath, HTML);
    // Age the file so it looks "stale" to the wall-clock freshness gate.
    utimesSync(indexPath, OLD_MTIME_S, OLD_MTIME_S);

    serve200 = true;
    server = createServer((_req, res) => {
      if (!serve200) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server addr");
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workdir, { recursive: true, force: true });
  });

  function routeVerification(): RouteUrlVerification {
    return {
      workdir,
      // Session started AFTER the file's mtime — this is exactly the skew that
      // used to trip the freshness gate.
      sessionStartedAtMs: Date.now(),
      mappings: [
        {
          urlPrefix: `http://127.0.0.1:${port}/`,
          localPath: ".",
          requireFresh: true,
        },
      ],
    };
  }

  it("does NOT flag a served-200 app whose file mtime predates the session", async () => {
    const url = `http://127.0.0.1:${port}/color-pop/`;
    const result = await annotateUnverifiedUrls(
      `built the app — it's live at ${url}`,
      undefined,
      "please build and deploy the app and give me the live url",
      undefined,
      undefined,
      routeVerification(),
    );

    // No spurious "not updated during this session" → no false retry.
    expect(result.dead).toEqual([]);
    expect(result.text).not.toContain("not updated during this session");
    expect(result.text).not.toContain("verification:");
    expect(result.verifiedUrls).toContain(url);
  });

  it("still flags a stale local file when the URL is NOT actually served (freshness gate preserved)", async () => {
    // Negative control: the same old-mtime file, but the server 404s, so the
    // local file is the only liveness signal. With requireFresh the stale file
    // must still be reported — the fix only suppresses the gate behind a live
    // 200, it does not remove it.
    serve200 = false;
    const url = `http://127.0.0.1:${port}/color-pop/`;
    const result = await annotateUnverifiedUrls(
      `built the app — it's live at ${url}`,
      undefined,
      "please build and deploy the app and give me the live url",
      undefined,
      undefined,
      routeVerification(),
    );

    expect(result.dead.length).toBeGreaterThan(0);
    // A 404 is itself a dead signal; the key contract is the URL is flagged.
    expect(result.dead.some((d) => d.url === url)).toBe(true);
  });
});

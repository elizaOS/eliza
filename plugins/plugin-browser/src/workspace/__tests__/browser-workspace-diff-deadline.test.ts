/**
 * Deadline tests for browser workspace page fetches.
 *
 * The desktop `diff url` subaction fetches two caller-supplied page URLs with
 * the raw page fetch. Every other hop in the workspace is bounded — the bridge
 * transport (`browser-workspace-desktop.ts` `requestBrowserWorkspace`) and the
 * tracked page fetch used by the web backend of the *same* subaction both carry
 * `AbortSignal.timeout(DEFAULT_TIMEOUT_MS)`. These tests pin that the desktop
 * hops are bounded too, that a caller abort still wins over the deadline, and
 * that ordinary fast responses are untouched.
 *
 * Every assertion runs against a real never-answering TCP socket, not a stub:
 * a fake `fetch` that never settles is indistinguishable from a slow one, and
 * the test runner's own timeout does not interrupt an in-flight `fetch`, so
 * each wait is raced against an explicit watchdog instead.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeBrowserWorkspaceCommand } from "../browser-workspace.js";
import {
  browserWorkspaceBoundedPageFetch,
  DEFAULT_TIMEOUT_MS,
} from "../browser-workspace-helpers.js";
import { fetchBrowserWorkspaceTrackedResponse } from "../browser-workspace-network.js";
import { getBrowserWorkspaceRuntimeState } from "../browser-workspace-state.js";

type Watchdog<T> = { value: T | "STILL-PENDING"; elapsedMs: number };

/** Race a promise against a watchdog so a never-settling fetch fails instead of hanging the suite. */
async function raceWatchdog<T>(
  work: Promise<T>,
  watchdogMs: number,
): Promise<Watchdog<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<"STILL-PENDING">((resolve) => {
    timer = setTimeout(() => resolve("STILL-PENDING"), watchdogMs);
  });
  try {
    const settled = await Promise.race([
      work.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      ),
      watchdog,
    ]);
    return { elapsedMs: Date.now() - startedAt, value: settled };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

/** Cause-aware: `fetch` wraps an abort reason in a TypeError on some runtimes. */
function abortReasonName(error: unknown): string {
  if (error instanceof Error && error.cause instanceof Error) {
    return error.cause.name;
  }
  return errorName(error);
}

let blackhole: http.Server;
let blackholeUrl: string;
let fastServer: http.Server;
let fastUrl: string;
let bridge: http.Server;
let bridgeEnv: NodeJS.ProcessEnv;

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  // Accepts the connection, reads the request, and never writes a response.
  blackhole = http.createServer(() => {});
  blackholeUrl = `${await listen(blackhole)}/never`;

  fastServer = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });
  fastUrl = `${await listen(fastServer)}/fast`;

  // Minimal desktop bridge: the diff path resolves a snapshot through `/eval`.
  bridge = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (/\/tabs\/[^/]+\/eval$/.test(request.url ?? "")) {
        response.end(
          JSON.stringify({
            result: {
              capturedAt: "2026-01-01T00:00:00.000Z",
              html: "<html></html>",
              text: "",
              title: "tab",
              url: "https://example.invalid/",
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ tabs: [] }));
    });
  });
  const bridgeUrl = await listen(bridge);
  bridgeEnv = { ELIZA_BROWSER_WORKSPACE_URL: bridgeUrl };
});

afterAll(async () => {
  await Promise.all(
    [blackhole, fastServer, bridge].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("browserWorkspaceBoundedPageFetch", () => {
  it("aborts a never-answering socket with a TimeoutError", async () => {
    const outcome = await raceWatchdog(
      browserWorkspaceBoundedPageFetch(blackholeUrl, {}, 300),
      3_000,
    );

    expect(outcome.value).not.toBe("STILL-PENDING");
    const settled = outcome.value as { ok: boolean; error?: unknown };
    expect(settled.ok).toBe(false);
    // Specifically the deadline, so dropping the caller signal cannot pass this.
    expect(abortReasonName(settled.error)).toBe("TimeoutError");
    expect(outcome.elapsedMs).toBeLessThan(3_000);
  });

  it("lets a caller abort win over the deadline instead of over-rejecting", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const outcome = await raceWatchdog(
      browserWorkspaceBoundedPageFetch(
        blackholeUrl,
        { signal: controller.signal },
        30_000,
      ),
      5_000,
    );

    expect(outcome.value).not.toBe("STILL-PENDING");
    const settled = outcome.value as { ok: boolean; error?: unknown };
    expect(settled.ok).toBe(false);
    expect(abortReasonName(settled.error)).toBe("AbortError");
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  it("leaves an ordinary fast response untouched", async () => {
    const response = await browserWorkspaceBoundedPageFetch(fastUrl, {}, 5_000);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
  });
});

describe("fetchBrowserWorkspaceTrackedResponse", () => {
  it(
    "keeps the hop deadline when the caller also supplies a signal",
    async () => {
      const state = getBrowserWorkspaceRuntimeState("web", "tracked-deadline");
      // A caller controller that never fires: on the `??` form this replaced the
      // deadline outright, so the hop had no bound at all.
      const controller = new AbortController();

      const outcome = await raceWatchdog(
        fetchBrowserWorkspaceTrackedResponse(
          state,
          blackholeUrl,
          { signal: controller.signal },
          "document",
        ),
        DEFAULT_TIMEOUT_MS + 8_000,
      );

      expect(outcome.value).not.toBe("STILL-PENDING");
      const settled = outcome.value as { ok: boolean; error?: unknown };
      expect(settled.ok).toBe(false);
      expect(abortReasonName(settled.error)).toBe("TimeoutError");
      expect(controller.signal.aborted).toBe(false);
    },
    DEFAULT_TIMEOUT_MS + 20_000,
  );
});

describe("desktop browser workspace diff url", () => {
  it(
    "does not hang forever on a never-answering page",
    async () => {
      const outcome = await raceWatchdog(
        executeBrowserWorkspaceCommand(
          {
            diffAction: "url",
            id: "tab-1",
            secondaryUrl: blackholeUrl,
            subaction: "diff",
            url: blackholeUrl,
          },
          bridgeEnv,
        ),
        DEFAULT_TIMEOUT_MS + 8_000,
      );

      expect(outcome.value).not.toBe("STILL-PENDING");
      const settled = outcome.value as { ok: boolean; error?: unknown };
      expect(settled.ok).toBe(false);
      expect(abortReasonName(settled.error)).toBe("TimeoutError");
    },
    DEFAULT_TIMEOUT_MS + 20_000,
  );

  it("still returns a diff for pages that answer", async () => {
    const result = await executeBrowserWorkspaceCommand(
      {
        diffAction: "url",
        id: "tab-1",
        secondaryUrl: fastUrl,
        subaction: "diff",
        url: fastUrl,
      },
      bridgeEnv,
    );

    expect(result.mode).toBe("desktop");
    expect(result.subaction).toBe("diff");
    expect(result.value).toBeDefined();
  }, 30_000);
});

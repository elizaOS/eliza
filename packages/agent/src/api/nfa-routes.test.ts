import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNfaRoutes as handleNfaRoutesLazy } from "./server-lazy-routes.ts";

const originalStateDir = process.env.ELIZA_STATE_DIR;
let tempStateDir: string | null = null;

function makeContext(pathname: string, method = "GET") {
  const json = vi.fn();
  const error = vi.fn();
  const ctx = {
    req: { url: pathname } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    json,
    error,
  } satisfies Parameters<typeof handleNfaRoutesLazy>[0];
  return { ctx, json, error };
}

describe("handleNfaRoutes lazy dispatch", () => {
  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), "eliza-nfa-routes-"));
    process.env.ELIZA_STATE_DIR = tempStateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }
    if (tempStateDir) {
      rmSync(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    vi.restoreAllMocks();
  });

  it("forwards /api/nfa/status to the NFA handler", async () => {
    const { ctx, json } = makeContext("/api/nfa/status");

    await expect(handleNfaRoutesLazy(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      nfa: null,
      identity: null,
      configured: false,
    });
  });

  it("does not import or forward unrelated routes", async () => {
    const { ctx } = makeContext("/api/agent/self-status");

    await expect(handleNfaRoutesLazy(ctx)).resolves.toBe(false);
  });
});

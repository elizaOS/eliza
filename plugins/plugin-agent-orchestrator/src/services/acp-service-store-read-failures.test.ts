/**
 * A failing session-store read on a terminal path must be reported, not left
 * as an unhandled rejection. `AcpService` ends every sub-agent session through
 * a terminal event (`stopped` / `error` / `cancelled`) or through the `runAcpx`
 * close handler that marks a crashed session `errored`. Both paths read the
 * session store with a voided `.then()` chain that has no `.catch()`, so a
 * database or file-store read failure rejects a promise nobody observes. The
 * rejection escapes as an unhandled rejection at the exact moment a session
 * ends: hosts without the process crash guards die on it, and guarded servers
 * only log a generic line with no scope or session context, so the store
 * outage never reaches `reportError` diagnostics. These tests drive the real
 * service against a store whose reads fail and watch for the rejection.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "./acp-service.js";
import type { SessionStore } from "./types.js";

const STORE_ERROR = new Error("session store read failed");

function failingStore(): SessionStore {
  return {
    get: async () => {
      throw STORE_ERROR;
    },
  } as unknown as SessionStore;
}

function runtimeWithCli(cliPath?: string) {
  const values: Record<string, string> = {};
  if (cliPath) values.ELIZA_ACP_CLI = cliPath;
  const reportError = vi.fn();
  const runtime = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (key: string) => values[key],
    getService: () => null,
    services: new Map(),
    reportError,
  } as never;
  return { runtime, reportError };
}

/** Collect rejections Node would otherwise report as unhandled. */
async function collectUnhandled(
  trigger: () => void | Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const handler = (error: unknown) => {
    seen.push(error);
  };
  process.on("unhandledRejection", handler);
  try {
    await trigger();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", handler);
  }
  return seen;
}

let workdir: string;
let cliPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "acp-store-read-failures-"));
  cliPath = path.join(workdir, "fake-acpx-crashing.mjs");
  await writeFile(cliPath, "#!/usr/bin/env node\nprocess.exit(1);\n");
  await chmod(cliPath, 0o755);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("AcpService terminal store-read failures", () => {
  it("reports a failing store read on a terminal event instead of leaving it unhandled", async () => {
    const { runtime, reportError } = runtimeWithCli();
    const service = new AcpService(runtime, { store: failingStore() });
    const unhandled = await collectUnhandled(() => {
      service.emitSessionEvent("session-1", "stopped", {
        sessionId: "session-1",
        response: "",
        exitCode: 1,
        signal: null,
      });
    });
    expect(unhandled).toHaveLength(0);
    expect(reportError).toHaveBeenCalledWith(
      "AcpService.terminalSessionCleanup",
      STORE_ERROR,
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("reports a failing store read when a crashed subprocess is marked errored", async () => {
    const { runtime, reportError } = runtimeWithCli(cliPath);
    const service = new AcpService(runtime, { store: failingStore() });
    const unhandled = await collectUnhandled(async () => {
      const result = await (
        service as unknown as {
          runAcpx: (opts: {
            sessionId: string;
            agentType: string;
            workdir: string;
            args: string[];
          }) => Promise<{ code: number | null }>;
        }
      ).runAcpx({
        sessionId: "session-1",
        agentType: "codex",
        workdir,
        args: [],
      });
      expect(result.code).toBe(1);
    });
    expect(unhandled).toHaveLength(0);
    expect(reportError).toHaveBeenCalledWith(
      "AcpService.markErroredOnCrash",
      STORE_ERROR,
      expect.objectContaining({ sessionId: "session-1", code: 1 }),
    );
  });
});

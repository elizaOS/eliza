/**
 * Integration proof that failed-start cleanup terminates an actual OS child.
 * Only health and wallet collaborators are substituted; node:child_process is
 * real, and the assertion probes the spawned PID after the lifecycle rejects.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./steward-sidecar/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./steward-sidecar/helpers")>();
  return {
    ...actual,
    allocateFirstFreeLoopbackPort: vi.fn(async (port: number) => port),
  };
});

vi.mock("./steward-sidecar/health-check", () => ({
  waitForHealthy: vi.fn(async () => {
    throw new Error("integration health failure");
  }),
}));

vi.mock("./steward-sidecar/wallet-setup", () => ({
  ensureWalletSetup: vi.fn(),
}));

import { StewardSidecar } from "./steward-sidecar";

let observedPid: number | null = null;
let tempDir: string | null = null;

function processStillExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (observedPid && processStillExists(observedPid)) {
    process.kill(observedPid, "SIGKILL");
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  observedPid = null;
  tempDir = null;
});

describe("StewardSidecar real child cleanup", () => {
  it("leaves no live OS process after a post-spawn health failure", async () => {
    vi.stubGlobal("Bun", undefined);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-steward-child-"));
    const childEntry = path.join(tempDir, "child.mjs");
    fs.writeFileSync(childEntry, "setInterval(() => {}, 1_000);\n", "utf8");

    const sidecar = new StewardSidecar({
      dataDir: path.join(tempDir, "state"),
      stewardEntryPoint: childEntry,
      onStatusChange: (status) => {
        if (status.pid !== null) observedPid = status.pid;
      },
    });

    await expect(sidecar.start()).rejects.toThrow("integration health failure");

    expect(observedPid).not.toBeNull();
    expect(processStillExists(observedPid as number)).toBe(false);
    expect(sidecar.getStatus()).toMatchObject({ state: "error", pid: null });
  });
});

/**
 * Electrobun Steward reset contract when child termination cannot be proven.
 * The native boundary must propagate the stop failure before deleting wallet
 * state, so the renderer RPC rejects instead of reporting a fabricated reset.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const terminationError = Object.assign(
    new Error("Steward child failed to confirm exit after SIGTERM and SIGKILL"),
    { code: "STEWARD_CHILD_TERMINATION_FAILED" },
  );
  const sidecar = {
    stop: vi.fn(async () => {
      throw terminationError;
    }),
    restart: vi.fn(),
    start: vi.fn(),
    getStatus: vi.fn(() => ({ state: "error" })),
    getCredentials: vi.fn(() => null),
    getApiBase: vi.fn(() => "http://127.0.0.1:3200"),
  };
  return { sidecar, terminationError };
});

vi.mock("@elizaos/app-core", () => ({
  createDesktopStewardSidecar: vi.fn(() => mocks.sidecar),
}));

vi.mock("../brand-config", () => ({
  getBrandConfig: vi.fn(() => ({ namespace: "eliza" })),
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { getStewardSidecar, resetSteward } from "./steward";

let originalHome: string | undefined;
let originalDataDir: string | undefined;
let tempHome: string;
let dataDir: string;
let walletSentinel: string;

beforeAll(async () => {
  originalHome = process.env.HOME;
  originalDataDir = process.env.STEWARD_DATA_DIR;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-steward-reset-"));
  dataDir = path.join(tempHome, ".eliza", "steward");
  walletSentinel = path.join(dataDir, "wallet-state");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(walletSentinel, "must survive", "utf8");
  process.env.HOME = tempHome;
  process.env.STEWARD_DATA_DIR = dataDir;
  await getStewardSidecar();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.STEWARD_DATA_DIR;
  else process.env.STEWARD_DATA_DIR = originalDataDir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("Electrobun Steward reset after termination failure", () => {
  it("rejects before deleting wallet state", async () => {
    await expect(resetSteward()).rejects.toBe(mocks.terminationError);

    expect(mocks.sidecar.stop).toHaveBeenCalledTimes(1);
    expect(mocks.sidecar.start).not.toHaveBeenCalled();
    expect(fs.readFileSync(walletSentinel, "utf8")).toBe("must survive");
  });
});

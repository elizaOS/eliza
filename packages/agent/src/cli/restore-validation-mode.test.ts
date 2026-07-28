/**
 * Proves the CLI selects the restore-only server before importing any normal
 * runtime entry point and rejects alternate commands under the provider mode.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const startRestoreValidationProcess = vi.fn(async () => undefined);
const startEliza = vi.fn(async () => undefined);
const bootElizaRuntime = vi.fn(async () => undefined);

vi.mock("../api/restore-validation-server.ts", () => ({
  startRestoreValidationProcess,
}));
vi.mock("../runtime/index.ts", () => ({
  bootElizaRuntime,
  startEliza,
}));

const ORIGINAL_BOOT_MODE = process.env.ELIZA_RUNTIME_BOOT_MODE;

afterEach(() => {
  startRestoreValidationProcess.mockClear();
  startEliza.mockClear();
  bootElizaRuntime.mockClear();
  if (ORIGINAL_BOOT_MODE === undefined) {
    delete process.env.ELIZA_RUNTIME_BOOT_MODE;
  } else {
    process.env.ELIZA_RUNTIME_BOOT_MODE = ORIGINAL_BOOT_MODE;
  }
});

describe("restore-validation CLI dispatch", () => {
  test("starts only the minimal server for serve and start", async () => {
    process.env.ELIZA_RUNTIME_BOOT_MODE = "restore-validation";
    const { runAutonomousCli } = await import("./index.ts");

    await runAutonomousCli(["node", "eliza-autonomous", "serve"]);
    await runAutonomousCli(["node", "eliza-autonomous", "start"]);

    expect(startRestoreValidationProcess).toHaveBeenCalledTimes(2);
    expect(startEliza).not.toHaveBeenCalled();
    expect(bootElizaRuntime).not.toHaveBeenCalled();
  });

  test("rejects alternate runtime entry and unknown modes before normal boot", async () => {
    const { runAutonomousCli } = await import("./index.ts");
    process.env.ELIZA_RUNTIME_BOOT_MODE = "restore-validation";
    await expect(
      runAutonomousCli(["node", "eliza-autonomous", "runtime"]),
    ).rejects.toThrow("cannot enter the full agent runtime");
    process.env.ELIZA_RUNTIME_BOOT_MODE = "restor-validation";
    await expect(
      runAutonomousCli(["node", "eliza-autonomous", "serve"]),
    ).rejects.toThrow("Unsupported runtime boot mode");

    expect(startRestoreValidationProcess).not.toHaveBeenCalled();
    expect(startEliza).not.toHaveBeenCalled();
    expect(bootElizaRuntime).not.toHaveBeenCalled();
  });
});

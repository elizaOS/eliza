import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { runAllChecks } from "../doctor/checks";
import { registerDoctorCommand } from "./register.doctor";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../doctor/checks", () => ({ runAllChecks: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function run(json: boolean) {
  const program = new Command();
  registerDoctorCommand(program);
  await program.parseAsync([
    "node",
    "eliza",
    "doctor",
    "--fix",
    "--no-ports",
    ...(json ? ["--json"] : []),
  ]);
}

const broken = {
  label: "Config",
  category: "config" as const,
  status: "fail" as const,
  autoFixable: true,
  fix: "eliza setup",
};
const healthy = {
  label: "Config",
  category: "config" as const,
  status: "pass" as const,
};

it("deduplicates repairs and reports the refreshed checks as JSON", async () => {
  vi.mocked(runAllChecks)
    .mockResolvedValueOnce([broken, { ...broken, label: "Model" }])
    .mockResolvedValueOnce([healthy]);
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<
    typeof spawnSync
  >);
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  await run(true);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(spawnSync).toHaveBeenCalledWith(expect.any(String), ["setup"], {
    stdio: ["inherit", 2, 2],
  });
  expect(runAllChecks).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual({
    summary: { pass: 1, fail: 0, warn: 0, skip: 0 },
    checks: [healthy],
    fixFailures: [],
  });
  expect(exit).not.toHaveBeenCalled();
});

it("does not claim success when the repair command fails despite healthy recheck", async () => {
  vi.mocked(runAllChecks)
    .mockResolvedValueOnce([broken])
    .mockResolvedValueOnce([healthy]);
  vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<
    typeof spawnSync
  >);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  await run(false);
  expect(exit).toHaveBeenCalledWith(1);
  expect(error).toHaveBeenCalledWith("Auto-fix failed: eliza setup");
  expect(log.mock.calls.flat().join(" ")).not.toContain(
    "Everything looks good",
  );
});

import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const checkForUpdate = vi.fn();
const performUpdate = vi.fn();

vi.mock("@elizaos/agent", () => ({
  resolveElizaVersion: () => "1.0.0",
  loadElizaConfig: () => ({}),
  saveElizaConfig: vi.fn(),
  checkForUpdate,
  resolveChannel: () => "stable",
  detectInstallMethod: () => "npm-global",
  getUpdateActionPlan: () => ({ canExecuteFromContext: true }),
  performUpdate,
}));

const { registerUpdateCommand } = await import("./register.update");

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  checkForUpdate.mockReset();
  performUpdate.mockReset();
});

async function run(...args: string[]) {
  const program = new Command();
  registerUpdateCommand(program);
  await program.parseAsync(["node", "eliza", "update", ...args]);
}

it("exits non-zero when `update --check` cannot check for updates", async () => {
  checkForUpdate.mockResolvedValue({ error: "registry unreachable" });
  await run("--check");
  expect(exit).toHaveBeenCalledWith(1);
  expect(performUpdate).not.toHaveBeenCalled();
});

it("exits non-zero when a plain update cannot check for updates", async () => {
  checkForUpdate.mockResolvedValue({ error: "registry unreachable" });
  await run();
  expect(exit).toHaveBeenCalledWith(1);
  expect(performUpdate).not.toHaveBeenCalled();
});

it("exits zero when `update --check` finds the install up to date", async () => {
  checkForUpdate.mockResolvedValue({ updateAvailable: false });
  await run("--check");
  expect(exit).not.toHaveBeenCalled();
});

/**
 * Direct unit coverage for `registerDoctorCommand`. Drives a real Commander
 * program through `doctor` and `doctor:mtp` so grouping order, empty categories,
 * JSON summaries, exit codes, and `--fix` spawn policy are recorded as the
 * registrar actually behaves. `runAllChecks` / `runMtpDoctor` are fixtures
 * (those modules have their own suites); auto-fix is a real `spawnSync` of a
 * temp `ELIZA_BIN`.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../doctor/checks";
import { registerDoctorCommand } from "./register.doctor";

const doctorState = vi.hoisted(() => ({
  results: [] as CheckResult[],
  lastOpts: undefined as { checkPorts?: boolean } | undefined,
}));

const mtpState = vi.hoisted(() => ({
  report: {
    ok: true,
    checks: [] as Array<{
      label: string;
      status: "pass" | "warn" | "fail" | "skip";
      detail: string;
      fix?: string;
    }>,
  },
}));

vi.mock("../doctor/checks", () => ({
  runAllChecks: async (opts: { checkPorts?: boolean }) => {
    doctorState.lastOpts = opts;
    return doctorState.results;
  },
}));

vi.mock("@elizaos/plugin-local-inference/services", () => ({
  runMtpDoctor: async () => mtpState.report,
}));

const ORIGINAL_ELIZA_BIN = process.env.ELIZA_BIN;
const ORIGINAL_FIX_LOG = process.env.ELIZA_FIX_LOG;
const ORIGINAL_FIX_EXIT = process.env.ELIZA_FIX_EXIT;

const tempDirs: string[] = [];
const logs: string[] = [];
const writes: string[] = [];
const exitCodes: number[] = [];

function stripAnsi(value: string): string {
  const esc = String.fromCharCode(27);
  return value.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function humanOutput(): string {
  return stripAnsi(logs.join("\n"));
}

function jsonPayload(): {
  summary?: { pass: number; warn: number; fail: number; skip: number };
  checks?: CheckResult[];
  ok?: boolean;
} {
  const text = writes.join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`no JSON written: ${text}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as ReturnType<
    typeof jsonPayload
  >;
}

function check(result: CheckResult): CheckResult {
  return result;
}

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program);
  await program.parseAsync(argv, { from: "user" });
}

function writeFixBin(): { bin: string; logPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "register-doctor-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "eliza-fix");
  const logPath = path.join(dir, "invocations.log");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$ELIZA_FIX_LOG"',
      'if [ -z "$ELIZA_FIX_EXIT" ]; then ELIZA_FIX_EXIT=0; fi',
      'exit "$ELIZA_FIX_EXIT"',
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.ELIZA_BIN = bin;
  process.env.ELIZA_FIX_LOG = logPath;
  return { logPath };
}

function spawnedArgs(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("registerDoctorCommand", () => {
  beforeEach(() => {
    doctorState.results = [];
    doctorState.lastOpts = undefined;
    mtpState.report = { ok: true, checks: [] };
    logs.length = 0;
    writes.length = 0;
    exitCodes.length = 0;
    delete process.env.ELIZA_BIN;
    delete process.env.ELIZA_FIX_LOG;
    delete process.env.ELIZA_FIX_EXIT;

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ELIZA_BIN === undefined) delete process.env.ELIZA_BIN;
    else process.env.ELIZA_BIN = ORIGINAL_ELIZA_BIN;
    if (ORIGINAL_FIX_LOG === undefined) delete process.env.ELIZA_FIX_LOG;
    else process.env.ELIZA_FIX_LOG = ORIGINAL_FIX_LOG;
    if (ORIGINAL_FIX_EXIT === undefined) delete process.env.ELIZA_FIX_EXIT;
    else process.env.ELIZA_FIX_EXIT = ORIGINAL_FIX_EXIT;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers doctor:mtp then doctor with the shipped flags", () => {
    const program = new Command();
    registerDoctorCommand(program);
    expect(program.commands.map((command) => command.name())).toEqual([
      "doctor:mtp",
      "doctor",
    ]);

    const mtp = program.commands.find(
      (command) => command.name() === "doctor:mtp",
    );
    const doctor = program.commands.find(
      (command) => command.name() === "doctor",
    );
    expect(mtp?.description()).toBe(
      "Check MTP llama-server acceleration readiness",
    );
    expect(doctor?.description()).toBe(
      "Check environment health and diagnose common issues",
    );
    expect(mtp?.options.map((option) => option.flags)).toEqual(["--json"]);
    expect(doctor?.options.map((option) => option.flags)).toEqual([
      "--no-ports",
      "--fix",
      "--json",
    ]);
  });

  it("JSON empty queue: zero summary, no process.exit", async () => {
    await runCli(["doctor", "--json"]);
    expect(jsonPayload()).toEqual({
      summary: { pass: 0, warn: 0, fail: 0, skip: 0 },
      checks: [],
    });
    expect(exitCodes).toEqual([]);
    expect(doctorState.lastOpts).toEqual({ checkPorts: true });
  });

  it("JSON summary counts mixed statuses and exits only when fail > 0", async () => {
    doctorState.results = [
      check({ label: "A", status: "pass", category: "system" }),
      check({ label: "B", status: "pass", category: "config" }),
      check({ label: "C", status: "warn", category: "storage" }),
      check({ label: "D", status: "fail", category: "network" }),
      check({ label: "E", status: "fail", category: "network" }),
      check({ label: "F", status: "fail", category: "system" }),
      check({ label: "G", status: "skip", category: "config" }),
    ];
    await runCli(["doctor", "--json"]);
    expect(jsonPayload().summary).toEqual({
      pass: 2,
      warn: 1,
      fail: 3,
      skip: 1,
    });
    expect(exitCodes).toEqual([1]);
  });

  it("JSON with warnings and skips but no fails does not exit", async () => {
    doctorState.results = [
      check({ label: "W", status: "warn", category: "config" }),
      check({ label: "S", status: "skip", category: "network" }),
    ];
    await runCli(["doctor", "--json"]);
    expect(jsonPayload().summary).toEqual({
      pass: 0,
      warn: 1,
      fail: 0,
      skip: 1,
    });
    expect(exitCodes).toEqual([]);
  });

  it("forwards --no-ports as checkPorts: false", async () => {
    await runCli(["doctor", "--no-ports", "--json"]);
    expect(doctorState.lastOpts).toEqual({ checkPorts: false });
  });

  it("does not auto-fix when --json returns before the fix pass", async () => {
    const { logPath } = writeFixBin();
    doctorState.results = [
      check({
        label: "Config",
        status: "fail",
        category: "config",
        autoFixable: true,
        fix: "eliza configure --yes",
      }),
    ];
    await runCli(["doctor", "--json", "--fix"]);
    expect(spawnedArgs(logPath)).toEqual([]);
    expect(exitCodes).toEqual([1]);
  });

  it("human empty queue: heading, success line, no category labels, no exit", async () => {
    await runCli(["doctor"]);
    const output = humanOutput();
    expect(output).toContain("Eliza Health Check");
    expect(output).toContain("Everything looks good.");
    expect(output).toContain("eliza start");
    expect(output).not.toContain("System");
    expect(output).not.toContain("Configuration");
    expect(output).not.toContain("Storage");
    expect(output).not.toContain("Network");
    expect(exitCodes).toEqual([]);
  });

  it("skip-only results still print the all-clear line (skips are not warnings)", async () => {
    doctorState.results = [
      check({ label: "Optional", status: "skip", category: "network" }),
    ];
    await runCli(["doctor"]);
    expect(humanOutput()).toContain("Everything looks good.");
    expect(exitCodes).toEqual([]);
  });

  it("prints categories in system/config/storage/network order, omitting empty buckets", async () => {
    doctorState.results = [
      check({ label: "Net-1", status: "pass", category: "network" }),
      check({ label: "Store-1", status: "pass", category: "storage" }),
      check({ label: "Sys-Z", status: "pass", category: "system" }),
      check({ label: "Sys-A", status: "pass", category: "system" }),
    ];
    await runCli(["doctor"]);
    const output = humanOutput();
    const systemAt = output.indexOf("System");
    const configAt = output.indexOf("Configuration");
    const storageAt = output.indexOf("Storage");
    const networkAt = output.indexOf("Network");
    expect(systemAt).toBeGreaterThanOrEqual(0);
    expect(configAt).toBe(-1);
    expect(storageAt).toBeGreaterThan(systemAt);
    expect(networkAt).toBeGreaterThan(storageAt);
    // Same-category ties keep input order (push), not label sort.
    expect(output.indexOf("Sys-Z")).toBeLessThan(output.indexOf("Sys-A"));
  });

  it("drops a result whose category is not in the four buckets, but still counts it as a failure", async () => {
    doctorState.results = [
      check({
        label: "Ghost",
        status: "fail",
        category: "ghost" as CheckResult["category"],
        detail: "unbucketed",
      }),
    ];
    await runCli(["doctor"]);
    const output = humanOutput();
    expect(output).not.toContain("Ghost");
    expect(output).toContain("1 issue found");
    expect(exitCodes).toEqual([1]);
  });

  it("prints a fix hint only when status is not pass", async () => {
    doctorState.results = [
      check({
        label: "Healthy",
        status: "pass",
        category: "system",
        detail: "ok",
        fix: "eliza never-run",
      }),
      check({
        label: "Broken",
        status: "fail",
        category: "config",
        fix: "eliza configure",
      }),
      check({
        label: "Quiet",
        status: "warn",
        category: "storage",
      }),
    ];
    await runCli(["doctor"]);
    const output = humanOutput();
    expect(output).toContain("Healthy");
    expect(output).toContain("ok");
    expect(output).not.toContain("eliza never-run");
    expect(output).toContain("eliza configure");
    expect(output).toContain("Broken");
  });

  it("singular failure copy suggests --fix and exits 1", async () => {
    doctorState.results = [
      check({ label: "Disk", status: "fail", category: "storage" }),
    ];
    await runCli(["doctor"]);
    const output = humanOutput();
    expect(output).toContain("1 issue found");
    expect(output).not.toContain("issues found");
    expect(output).toContain("eliza doctor --fix");
    expect(exitCodes).toEqual([1]);
  });

  it("pluralizes failures and omits the --fix hint when already fixing", async () => {
    doctorState.results = [
      check({ label: "One", status: "fail", category: "system" }),
      check({ label: "Two", status: "fail", category: "config" }),
    ];
    await runCli(["doctor", "--fix"]);
    const output = humanOutput();
    expect(output).toContain("2 issues found");
    expect(output).not.toContain("eliza doctor --fix");
    expect(output).toContain("No auto-fixable issues");
    expect(exitCodes).toEqual([1]);
  });

  it("singular vs plural warning copy, without exiting", async () => {
    doctorState.results = [
      check({ label: "W1", status: "warn", category: "network" }),
    ];
    await runCli(["doctor"]);
    expect(humanOutput()).toMatch(/1 warning\b/);
    expect(exitCodes).toEqual([]);

    logs.length = 0;
    doctorState.results = [
      check({ label: "W1", status: "warn", category: "network" }),
      check({ label: "W2", status: "warn", category: "config" }),
    ];
    await runCli(["doctor"]);
    expect(humanOutput()).toContain("2 warnings");
    expect(exitCodes).toEqual([]);
  });

  it("spawns only eliza-prefixed autoFixable commands, in result order", async () => {
    const { logPath } = writeFixBin();
    doctorState.results = [
      check({
        label: "Pass-fixable",
        status: "pass",
        category: "system",
        autoFixable: true,
        fix: "eliza should-not-run",
      }),
      check({
        label: "Chmod",
        status: "fail",
        category: "storage",
        autoFixable: true,
        fix: "chmod 700 /tmp/state",
      }),
      check({
        label: "No-flag",
        status: "fail",
        category: "config",
        autoFixable: false,
        fix: "eliza configure",
      }),
      check({
        label: "Missing-fix",
        status: "fail",
        category: "config",
        autoFixable: true,
      }),
      check({
        label: "Eliza-one",
        status: "warn",
        category: "network",
        autoFixable: true,
        fix: "eliza  configure --yes",
      }),
      check({
        label: "Eliza-two",
        status: "fail",
        category: "system",
        autoFixable: true,
        fix: "eliza update",
      }),
    ];
    await runCli(["doctor", "--fix"]);
    expect(spawnedArgs(logPath)).toEqual(["configure --yes", "update"]);
    expect(humanOutput()).toContain("auto-fix:");
    expect(humanOutput()).not.toContain("No auto-fixable issues");
    expect(exitCodes).toEqual([1]);
  });

  it("still exits 1 after a successful auto-fix when the original results had failures", async () => {
    const { logPath } = writeFixBin();
    process.env.ELIZA_FIX_EXIT = "0";
    doctorState.results = [
      check({
        label: "Cfg",
        status: "fail",
        category: "config",
        autoFixable: true,
        fix: "eliza configure",
      }),
    ];
    await runCli(["doctor", "--fix"]);
    expect(spawnedArgs(logPath)).toEqual(["configure"]);
    expect(exitCodes).toEqual([1]);
  });

  it("a failing auto-fix binary does not change the original failure exit", async () => {
    const { logPath } = writeFixBin();
    process.env.ELIZA_FIX_EXIT = "1";
    doctorState.results = [
      check({
        label: "Cfg",
        status: "fail",
        category: "config",
        autoFixable: true,
        fix: "eliza configure",
      }),
    ];
    await runCli(["doctor", "--fix"]);
    expect(spawnedArgs(logPath)).toEqual(["configure"]);
    expect(exitCodes).toEqual([1]);
  });

  it("does not spawn a fix that is exactly 'eliza' with no subcommand space", async () => {
    const { logPath } = writeFixBin();
    doctorState.results = [
      check({
        label: "Bare",
        status: "fail",
        category: "config",
        autoFixable: true,
        fix: "eliza",
      }),
    ];
    await runCli(["doctor", "--fix"]);
    expect(spawnedArgs(logPath)).toEqual([]);
    expect(exitCodes).toEqual([1]);
  });
});

describe("registerDoctorCommand doctor:mtp", () => {
  beforeEach(() => {
    mtpState.report = { ok: true, checks: [] };
    logs.length = 0;
    writes.length = 0;
    exitCodes.length = 0;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("JSON ok report writes the payload and does not exit", async () => {
    mtpState.report = {
      ok: true,
      checks: [
        {
          label: "catalog metadata",
          status: "pass",
          detail: "1 MTP-capable model",
        },
      ],
    };
    await runCli(["doctor:mtp", "--json"]);
    expect(jsonPayload()).toEqual(mtpState.report);
    expect(exitCodes).toEqual([]);
  });

  it("JSON !ok report exits 1 after writing", async () => {
    mtpState.report = {
      ok: false,
      checks: [
        {
          label: "catalog metadata",
          status: "fail",
          detail: "none",
          fix: "publish drafters",
        },
      ],
    };
    await runCli(["doctor:mtp", "--json"]);
    expect(jsonPayload().ok).toBe(false);
    expect(exitCodes).toEqual([1]);
  });

  it("human output uses MTP heading, padEnd 28, and prints fix only for non-pass", async () => {
    mtpState.report = {
      ok: false,
      checks: [
        {
          label: "catalog metadata",
          status: "pass",
          detail: "ok",
          fix: "should-not-print",
        },
        {
          label: "accelerator",
          status: "warn",
          detail: "cpu",
          fix: "install vulkan",
        },
        {
          label: "drafter",
          status: "fail",
          detail: "missing",
          fix: "publish gguf",
        },
        {
          label: "odd",
          status: "skip",
          detail: "unknown-status-falls-to-error-icon",
        },
      ],
    };
    await runCli(["doctor:mtp"]);
    const output = humanOutput();
    expect(output).toContain("MTP Health Check");
    expect(output).toContain("catalog metadata");
    expect(output).toContain("ok");
    expect(output).not.toContain("should-not-print");
    expect(output).toContain("install vulkan");
    expect(output).toContain("publish gguf");
    expect(output).toContain("odd");
    expect(exitCodes).toEqual([1]);
  });

  it("human ok report with an empty check list does not exit", async () => {
    mtpState.report = { ok: true, checks: [] };
    await runCli(["doctor:mtp"]);
    expect(humanOutput()).toContain("MTP Health Check");
    expect(exitCodes).toEqual([]);
  });
});

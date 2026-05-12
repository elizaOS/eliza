/**
 * OSWorld task subset benchmark.
 *
 * Self-contained benchmark that exercises all computer-use capabilities
 * using the OSWorld action format (computer_13 structured actions).
 *
 * Runs 15 tasks across 5 domains:
 *   - file: file create/read/edit/list
 *   - term: terminal execute/session/blocking
 *   - win:  window listing
 *   - desk: desktop mouse/keyboard (OSWorld actions)
 *   - sec:  approval mode enforcement
 *
 * Run: FORCE_OSWORLD_BENCHMARK=1 bun run test:live
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerUseService } from "../../services/computer-use-service.js";

// ── Environment detection ───────────────────────────────────────────────

const forceRun = process.env.FORCE_OSWORLD_BENCHMARK === "1";
const describeIfBenchmark = forceRun ? describe : describe.skip;

// ── Helpers ─────────────────────────────────────────────────────────────

interface TaskResult {
  name: string;
  domain: string;
  steps: number;
  passed: boolean;
  timeMs: number;
}

function mockRuntime(overrides: Record<string, string> = {}): IAgentRuntime {
  return {
    character: {},
    getSetting: (key: string) => {
      if (key === "COMPUTER_USE_APPROVAL_MODE")
        return overrides.COMPUTER_USE_APPROVAL_MODE ?? "full_control";
      if (key === "COMPUTER_USE_SCREENSHOT_AFTER_ACTION") return "false";
      return overrides[key] ?? undefined;
    },
    getService: () => null,
  } as IAgentRuntime;
}

// ── Test Suite ──────────────────────────────────────────────────────────

describeIfBenchmark("OSWorld task subset benchmark", () => {
  let service: ComputerUseService;
  let tempDir: string;
  const results: TaskResult[] = [];

  beforeAll(async () => {
    service = (await ComputerUseService.start(
      mockRuntime(),
    )) as ComputerUseService;
    tempDir = mkdtempSync(join(tmpdir(), "osworld-benchmark-"));
  });

  afterAll(async () => {
    if (service) await service.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });

    // Print results table
    console.log(
      "\n╔══════════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "║                OSWorld Task Benchmark Results                   ║",
    );
    console.log(
      "╠════════════════════════════╦═══════╦═══════╦═════════╦══════════╣",
    );
    console.log(
      "║ Task                       ║ Domn  ║ Steps ║ Time    ║ Result   ║",
    );
    console.log(
      "╠════════════════════════════╬═══════╬═══════╬═════════╬══════════╣",
    );
    for (const r of results) {
      const name = r.name.slice(0, 26).padEnd(26);
      const domain = r.domain.slice(0, 5).padEnd(5);
      const steps = String(r.steps).padStart(3);
      const time = `${r.timeMs}ms`.padStart(7);
      const status = r.passed ? "  PASS  " : "  FAIL  ";
      console.log(`║ ${name} ║ ${domain} ║  ${steps}  ║ ${time} ║ ${status} ║`);
    }
    console.log(
      "╠════════════════════════════╩═══════╩═══════╩═════════╩══════════╣",
    );
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const avgMs =
      total > 0
        ? Math.round(results.reduce((s, r) => s + r.timeMs, 0) / total)
        : 0;
    console.log(
      `${`║ Passed: ${passed}/${total} (${rate}%)  |  Avg: ${avgMs}ms/task`.padEnd(
        66,
      )}║`,
    );

    // Domain breakdown
    const domains = [...new Set(results.map((r) => r.domain))];
    for (const d of domains) {
      const dTasks = results.filter((r) => r.domain === d);
      const dPassed = dTasks.filter((r) => r.passed).length;
      const dRate = Math.round((dPassed / dTasks.length) * 100);
      console.log(
        `${`║   ${d.padEnd(6)}: ${dPassed}/${dTasks.length} (${dRate}%)`.padEnd(
          66,
        )}║`,
      );
    }
    console.log(`╚${"═".repeat(66)}╝\n`);
  });

  // ── FILE DOMAIN ─────────────────────────────────────────────────────

  it("T01: File create & read", async () => {
    const t0 = Date.now();
    const fp = join(tempDir, "hello.txt");
    const content = "Hello from OSWorld!";

    const w = await service.executeFileAction({
      action: "write",
      path: fp,
      content,
    });
    const r = await service.executeFileAction({ action: "read", path: fp });

    const passed = w.success && r.success && r.content === content;
    results.push({
      name: "File Create & Read",
      domain: "file",
      steps: 2,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T02: File edit (find & replace)", async () => {
    const t0 = Date.now();
    const fp = join(tempDir, "edit.txt");
    writeFileSync(fp, "The quick brown fox jumps over the lazy dog.");

    const e = await service.executeFileAction({
      action: "edit",
      path: fp,
      old_text: "brown fox",
      new_text: "red fox",
    });
    const verify = readFileSync(fp, "utf-8");

    const passed =
      e.success && verify === "The quick red fox jumps over the lazy dog.";
    results.push({
      name: "File Edit",
      domain: "file",
      steps: 2,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T03: File append", async () => {
    const t0 = Date.now();
    const fp = join(tempDir, "append.txt");
    writeFileSync(fp, "line1\n");

    await service.executeFileAction({
      action: "append",
      path: fp,
      content: "line2\n",
    });
    const verify = readFileSync(fp, "utf-8");

    const passed = verify === "line1\nline2\n";
    results.push({
      name: "File Append",
      domain: "file",
      steps: 2,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T04: Directory listing", async () => {
    const t0 = Date.now();
    writeFileSync(join(tempDir, "x.txt"), "x");

    const r = await service.executeFileAction({
      action: "list",
      path: tempDir,
    });
    const names = (r.items ?? []).map((i) => i.name);

    const passed = r.success && names.includes("x.txt");
    results.push({
      name: "Directory Listing",
      domain: "file",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T05: File exists check", async () => {
    const t0 = Date.now();
    const fp = join(tempDir, "exists-check.txt");
    writeFileSync(fp, "hi");

    const yes = await service.executeFileAction({ action: "exists", path: fp });
    const no = await service.executeFileAction({
      action: "exists",
      path: join(tempDir, "nope.txt"),
    });

    const passed = yes.exists === true && no.exists === false;
    results.push({
      name: "File Exists Check",
      domain: "file",
      steps: 2,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  // ── TERMINAL DOMAIN ─────────────────────────────────────────────────

  it("T06: Terminal echo", async () => {
    const t0 = Date.now();
    const r = await service.executeTerminalAction({
      action: "execute",
      command: "echo benchmark-ok",
    });

    const passed = r.success && (r.output ?? "").includes("benchmark-ok");
    results.push({
      name: "Terminal Echo",
      domain: "term",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T07: Terminal pwd in /tmp", async () => {
    const t0 = Date.now();
    const r = await service.executeTerminalAction({
      action: "execute",
      command: "pwd",
      cwd: "/tmp",
    });

    const passed = r.success && (r.output ?? "").includes("/tmp");
    results.push({
      name: "Terminal PWD",
      domain: "term",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T08: Dangerous command blocked", async () => {
    const t0 = Date.now();
    const r = await service.executeTerminalAction({
      action: "execute",
      command: "rm -rf /",
    });

    const passed = !r.success;
    results.push({
      name: "Dangerous Cmd Block",
      domain: "term",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T09: Terminal session lifecycle", async () => {
    const t0 = Date.now();
    const c = await service.executeTerminalAction({
      action: "connect",
      cwd: tempDir,
    });
    const e = await service.executeTerminalAction({
      action: "execute",
      command: "ls",
      sessionId: c.sessionId,
    });
    const x = await service.executeTerminalAction({
      action: "close",
      sessionId: c.sessionId,
    });

    const passed = c.success && e.success && x.success;
    results.push({
      name: "Terminal Session",
      domain: "term",
      steps: 3,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  // ── WINDOW DOMAIN ──────────────────────────────────────────────────

  it("T10: Window listing", async () => {
    const t0 = Date.now();
    const r = await service.executeWindowAction({ action: "list" });

    const passed = r.success && Array.isArray(r.windows);
    results.push({
      name: "Window List",
      domain: "win",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  // ── DESKTOP DOMAIN (OSWorld actions) ────────────────────────────────

  it("T11: Desktop mouse move", async () => {
    const t0 = Date.now();
    const r = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [200, 200],
    });

    // Mouse move may fail if Accessibility permission is not granted
    if (!r.success) {
      console.log(`[T11 mouse_move error]: ${r.error}`);
    }
    // Mouse move without cliclick uses AppleScript or Python Quartz — may fail without accessibility permission.
    // Record truthfully but don't fail the test (permission issues are environment-specific).
    results.push({
      name: r.success ? "Desktop Mouse Move" : "Desktop Mouse Move (⚠ perm)",
      domain: "desk",
      steps: 1,
      passed: r.success,
      timeMs: Date.now() - t0,
    });
    // Don't assert — this is environment-dependent
    expect(typeof r.success).toBe("boolean");
  });

  it("T12: Desktop key press", async () => {
    const t0 = Date.now();
    const r = await service.executeDesktopAction({
      action: "key",
      key: "Escape",
    });

    const passed = r.success;
    results.push({
      name: "Desktop Key Press",
      domain: "desk",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  it("T13: Desktop key combo", async () => {
    const t0 = Date.now();
    const r = await service.executeDesktopAction({
      action: "key_combo",
      key: "shift+Escape",
    });

    const passed = r.success;
    results.push({
      name: "Desktop Key Combo",
      domain: "desk",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  // ── CROSS-DOMAIN ──────────────────────────────────────────────────

  it("T14: Terminal→File round-trip", async () => {
    const t0 = Date.now();
    const fp = join(tempDir, "from-terminal.txt");

    await service.executeTerminalAction({
      action: "execute",
      command: `echo "written by terminal" > "${fp}"`,
    });
    const r = await service.executeFileAction({ action: "read", path: fp });

    const passed =
      r.success && (r.content ?? "").includes("written by terminal");
    results.push({
      name: "Terminal→File Trip",
      domain: "multi",
      steps: 2,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });

  // ── SECURITY DOMAIN ────────────────────────────────────────────────

  it("T15: Approval mode off blocks actions", async () => {
    const t0 = Date.now();
    const offService = (await ComputerUseService.start(
      mockRuntime({ COMPUTER_USE_APPROVAL_MODE: "off" }),
    )) as ComputerUseService;

    const r = await offService.executeDesktopAction({
      action: "click",
      coordinate: [100, 100],
    });
    await offService.stop();

    const passed = !r.success && (r.error ?? "").includes("blocked");
    results.push({
      name: "Approval Off Block",
      domain: "sec",
      steps: 1,
      passed,
      timeMs: Date.now() - t0,
    });
    expect(passed).toBe(true);
  });
});

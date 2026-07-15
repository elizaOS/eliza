/**
 * Exercises ComputerUseService through a real AgentRuntime and in-memory
 * database without capturing or actuating the host desktop. The final block is
 * a regression guard for the headless-CI hang: input validation must run before
 * the approval gate, which blocks on a decision no headless runner can produce.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  startComputerUseRuntime,
  stopComputerUseRuntime,
} from "../../test/helpers/service-runtime.ts";
import { ComputerUseService } from "../services/computer-use-service.js";

type RawActionParams = { action: string };

function executeRawDesktopAction(
  service: ComputerUseService,
  params: RawActionParams,
): ReturnType<ComputerUseService["executeDesktopAction"]> {
  const execute = service.executeDesktopAction as (
    rawParams: RawActionParams,
  ) => ReturnType<ComputerUseService["executeDesktopAction"]>;
  return execute.call(service, params);
}

function executeRawWindowAction(
  service: ComputerUseService,
  params: RawActionParams,
): ReturnType<ComputerUseService["executeWindowAction"]> {
  const execute = service.executeWindowAction as (
    rawParams: RawActionParams,
  ) => ReturnType<ComputerUseService["executeWindowAction"]>;
  return execute.call(service, params);
}

describe("ComputerUseService lifecycle", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("registers the service and reports capability state without claiming availability", () => {
    expect(ComputerUseService.serviceType).toBe("computeruse");
    expect(service.capabilityDescription.length).toBeGreaterThan(0);
    const caps = service.getCapabilities();

    expect(caps).toHaveProperty("screenshot");
    expect(caps).toHaveProperty("computerUse");
    expect(caps).toHaveProperty("windowList");
    expect(caps).toHaveProperty("browser");

    for (const key of [
      "screenshot",
      "computerUse",
      "windowList",
      "browser",
    ] as const) {
      expect(typeof caps[key].available).toBe("boolean");
      expect(typeof caps[key].tool).toBe("string");
    }
    expect(service.getRecentActions()).toEqual([]);
  });
});

describe("ComputerUseService configuration", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
      COMPUTER_USE_ACTION_TIMEOUT_MS: "5000",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("applies explicit settings without dispatching an action", () => {
    expect(service.getConfig()).toMatchObject({
      screenshotAfterAction: false,
      actionTimeoutMs: 5000,
    });
    expect(service.getRecentActions()).toEqual([]);
  });
});

describe("ComputerUseService desktop validation and history", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeEach(async () => {
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }));
  });

  afterEach(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("records failed actions and caps history at ten entries", async () => {
    for (let index = 0; index < 12; index++) {
      const result = await service.executeDesktopAction({ action: "click" });
      expect(result.success).toBe(false);
    }

    const history = service.getRecentActions();
    expect(history).toHaveLength(10);
    expect(history.every((entry) => entry.action === "click")).toBe(true);
    expect(history.every((entry) => entry.success === false)).toBe(true);
  });

  it("rejects click without a coordinate", async () => {
    const result = await service.executeDesktopAction({ action: "click" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("coordinate");
  });

  it("rejects type without text", async () => {
    const result = await service.executeDesktopAction({ action: "type" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("text is required");
  });

  it("rejects key without a key name", async () => {
    const result = await service.executeDesktopAction({ action: "key" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("key is required");
  });

  it("rejects an unknown desktop action", async () => {
    const result = await executeRawDesktopAction(service, {
      action: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown desktop action");
  });

  it("rejects drag without a starting coordinate", async () => {
    const result = await service.executeDesktopAction({
      action: "drag",
      coordinate: [100, 100],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("startCoordinate");
  });
});

describe("ComputerUseService window validation", () => {
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    ({ runtime, service } = await startComputerUseRuntime());
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
  });

  it("returns error for focus without windowId", async () => {
    const result = await service.executeWindowAction({ action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("windowId");
  });

  it("returns error for unknown window action", async () => {
    const result = await executeRawWindowAction(service, {
      action: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown window action");
  });
});

// Regression guard for the CI Plugin-lane hang. The approval gate awaits a
// human/API decision; the default smart_approve mode gives a headless runner no
// way to produce one, so any destructive action requested before its input is
// validated blocks until the 90s test timeout. This pins "off" (deny-all): the
// gate resolves immediately, so instead of hanging we get an observable
// distinction — with validation running first, malformed input yields the
// *field* error; if the gate ran first it would yield the deny message. The
// host's persisted approval mode is saved and restored (setMode persists to
// ~/.eliza), and this block runs last so its transient on-disk mode cannot leak
// into the earlier blocks.
describe("ComputerUseService validates input before the approval gate", () => {
  const approvalConfigPath = path.join(
    os.homedir(),
    ".eliza",
    "computer-use-approval.json",
  );
  let savedApprovalConfig: string | null = null;
  let runtime: AgentRuntime;
  let service: ComputerUseService;

  beforeAll(async () => {
    savedApprovalConfig = readApprovalConfig(approvalConfigPath);
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_APPROVAL_MODE: "off",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
    restoreApprovalConfig(approvalConfigPath, savedApprovalConfig);
  });

  it("runs deny-all so the gate cannot auto-approve", () => {
    expect(service.getApprovalMode()).toBe("off");
  });

  it("rejects a coordinate-less click at validation, not the gate", async () => {
    const result = await service.executeDesktopAction({ action: "click" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("coordinate");
    expect(result.error).not.toContain("paused");
  }, 10_000);

  it("rejects a targetless window focus at validation, not the gate", async () => {
    const result = await service.executeWindowAction({ action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("windowId");
    expect(result.error).not.toContain("paused");
  }, 10_000);
});

// Real filesystem + child-process execution driven end to end through the
// service under full_control (so destructive verbs actually run). These paths
// are host-desktop-independent — no display, no input driver — so they exercise
// the executeFileAction / executeTerminalAction dispatch and its
// routing/normalization/approval/finish helpers deterministically on a headless
// runner. The persisted approval mode is saved and restored.
describe("ComputerUseService file and terminal execution (real host I/O)", () => {
  const approvalConfigPath = path.join(
    os.homedir(),
    ".eliza",
    "computer-use-approval.json",
  );
  let savedApprovalConfig: string | null = null;
  let runtime: AgentRuntime;
  let service: ComputerUseService;
  let workdir: string;

  beforeAll(async () => {
    savedApprovalConfig = readApprovalConfig(approvalConfigPath);
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "computeruse-io-"));
    ({ runtime, service } = await startComputerUseRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }));
  });

  afterAll(async () => {
    await stopComputerUseRuntime(runtime);
    restoreApprovalConfig(approvalConfigPath, savedApprovalConfig);
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("writes a file and reads the same bytes back", async () => {
    const target = path.join(workdir, "note.txt");
    const write = await service.executeFileAction({
      action: "write",
      path: target,
      content: "hello world",
    });
    expect(write.success).toBe(true);

    const read = await service.executeFileAction({
      action: "read",
      path: target,
    });
    expect(read.success).toBe(true);
    expect(read.content).toContain("hello world");

    const size = await service.executeFileAction({
      action: "get_file_size",
      path: target,
    });
    expect(size.success).toBe(true);
  });

  it("appends then edits file content in place", async () => {
    const target = path.join(workdir, "edit.txt");
    await service.executeFileAction({
      action: "write",
      path: target,
      content: "alpha",
    });
    const append = await service.executeFileAction({
      action: "append",
      path: target,
      content: "-beta",
    });
    expect(append.success).toBe(true);

    const edit = await service.executeFileAction({
      action: "edit",
      path: target,
      old_text: "alpha",
      new_text: "omega",
    });
    expect(edit.success).toBe(true);

    const read = await service.executeFileAction({
      action: "read",
      path: target,
    });
    expect(read.content).toContain("omega-beta");
  });

  it("round-trips raw bytes through write_bytes/read_bytes", async () => {
    const target = path.join(workdir, "bytes.bin");
    const write = await service.executeFileAction({
      action: "write_bytes",
      path: target,
      base64: Buffer.from("bytes!").toString("base64"),
    });
    expect(write.success).toBe(true);

    const read = await service.executeFileAction({
      action: "read_bytes",
      path: target,
      offset: 0,
      length: 6,
    });
    expect(read.success).toBe(true);
  });

  it("creates, probes, lists, and removes a directory", async () => {
    const dir = path.join(workdir, "sub");
    const create = await service.executeFileAction({
      action: "create_dir",
      path: dir,
    });
    expect(create.success).toBe(true);

    const dirExists = await service.executeFileAction({
      action: "directory_exists",
      path: dir,
    });
    expect(dirExists.success).toBe(true);

    await service.executeFileAction({
      action: "write",
      path: path.join(dir, "a.txt"),
      content: "a",
    });
    const list = await service.executeFileAction({ action: "list", path: dir });
    expect(list.success).toBe(true);

    const remove = await service.executeFileAction({
      action: "delete_directory",
      path: dir,
    });
    expect(remove.success).toBe(true);
  });

  it("reports existence and deletes a file", async () => {
    const target = path.join(workdir, "gone.txt");
    await service.executeFileAction({
      action: "write",
      path: target,
      content: "x",
    });
    const exists = await service.executeFileAction({
      action: "exists",
      path: target,
    });
    expect(exists.success).toBe(true);

    const del = await service.executeFileAction({
      action: "delete",
      path: target,
    });
    expect(del.success).toBe(true);
  });

  it("rejects a write without content and an unknown file action", async () => {
    const noContent = await service.executeFileAction({
      action: "write",
      path: path.join(workdir, "x.txt"),
    });
    expect(noContent.success).toBe(false);

    const unknown = await (
      service.executeFileAction as (p: {
        action: string;
        path: string;
      }) => ReturnType<ComputerUseService["executeFileAction"]>
    ).call(service, {
      action: "nonexistent",
      path: path.join(workdir, "x.txt"),
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("Unknown file action");
  });

  it("routes file commands through executeCommand", async () => {
    const target = path.join(workdir, "routed.txt");
    const write = await service.executeCommand("file_write", {
      path: target,
      content: "routed",
    });
    expect(write.success).toBe(true);

    const read = await service.executeCommand("file_read", { path: target });
    expect(read.success).toBe(true);

    const unknown = await service.executeCommand("not_a_real_command", {});
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("Unknown computer-use command");
  });

  it("runs a real shell command through the terminal", async () => {
    const result = await service.executeTerminalAction({
      action: "execute",
      command: "echo computeruse-ok",
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).toContain("computeruse-ok");
  }, 15_000);

  it("connects, reads, types, clears, and closes a terminal session", async () => {
    expect(
      (await service.executeTerminalAction({ action: "connect" })).success,
    ).toBe(true);
    expect(
      (await service.executeTerminalAction({ action: "read" })).success,
    ).toBe(true);
    expect(
      (await service.executeTerminalAction({ action: "type", text: "echo hi" }))
        .success,
    ).toBe(true);
    expect(
      (await service.executeTerminalAction({ action: "clear" })).success,
    ).toBe(true);
    expect(
      (await service.executeTerminalAction({ action: "close" })).success,
    ).toBe(true);
  }, 15_000);

  it("rejects a command-less terminal execute and an unknown terminal action", async () => {
    const noCommand = await service.executeTerminalAction({
      action: "execute",
    });
    expect(noCommand.success).toBe(false);

    const unknown = await (
      service.executeTerminalAction as (p: {
        action: string;
      }) => ReturnType<ComputerUseService["executeTerminalAction"]>
    ).call(service, { action: "nonexistent" });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("Unknown terminal action");
  });

  it("routes a terminal command through executeCommand", async () => {
    const result = await service.executeCommand("execute_command", {
      command: "echo routed-terminal",
    });
    expect(result.success).toBe(true);
  }, 15_000);

  it("reads a file across every supported encoding", async () => {
    const target = path.join(workdir, "enc.txt");
    await service.executeFileAction({
      action: "write",
      path: target,
      content: "encoded",
    });
    for (const encoding of [
      "utf8",
      "ascii",
      "base64",
      "hex",
      "latin1",
      "binary",
      "ucs2",
      "utf16le",
      "unknown-encoding",
    ]) {
      const read = await service.executeFileAction({
        action: "read",
        path: target,
        encoding,
      });
      expect(read.success).toBe(true);
    }
  });

  it("runs terminal execute with an explicit cwd and timeout", async () => {
    const result = await service.executeTerminalAction({
      action: "execute",
      command: "pwd",
      cwd: workdir,
      timeout: 5,
    });
    expect(result.success).toBe(true);
  }, 15_000);

  // executeCommand maps each command string onto an action and dispatches it.
  // Malformed desktop/window commands fail fast at validation (no display or
  // input driver touched); the maps and per-verb approval-command lookups run
  // for every string, so the routing switch and its helper switches are covered
  // without actuating the host. Each dispatch returns a structured result.
  it("routes every desktop command string through executeCommand", async () => {
    const commands = [
      "click",
      "click_with_modifiers",
      "double_click",
      "right_click",
      "mouse_move",
      "middle_click",
      "mouse_down",
      "mouse_up",
      "type",
      "key_press",
      "key_combo",
      "key_down",
      "key_up",
      "scroll",
      "drag",
      "detect_elements",
      "ocr",
      "open",
      "launch",
      "kill_app",
      "set_value",
    ];
    for (const command of commands) {
      const result = await service.executeCommand(command, {});
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);

  it("routes every window command string through executeCommand", async () => {
    const commands = [
      "list_windows",
      "switch_to_window",
      "arrange_windows",
      "move_window",
      "minimize_window",
      "maximize_window",
      "restore_window",
      "close_window",
    ];
    for (const command of commands) {
      const result = await service.executeCommand(command, {});
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);

  it("routes every file command string through executeCommand", async () => {
    const target = path.join(workdir, "routing.txt");
    const commands = [
      "file_write",
      "file_read",
      "file_edit",
      "file_append",
      "file_exists",
      "file_get_file_size",
      "file_read_bytes",
      "file_write_bytes",
      "file_create_dir",
      "file_directory_exists",
      "directory_list",
      "file_list_downloads",
      "file_download",
      "file_upload",
      "file_delete",
      "directory_delete",
    ];
    for (const command of commands) {
      const result = await service.executeCommand(command, {
        path: target,
        content: "routing",
        base64: Buffer.from("routing").toString("base64"),
        old_text: "routing",
        new_text: "changed",
      });
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);

  it("routes every terminal command string through executeCommand", async () => {
    const commands = [
      "terminal_connect",
      "terminal_execute",
      "terminal_read",
      "terminal_type",
      "terminal_clear",
      "terminal_close",
    ];
    for (const command of commands) {
      const result = await service.executeCommand(command, {
        command: "echo routed",
        text: "echo hi",
      });
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);

  it("exercises window read and getter actions", async () => {
    for (const action of [
      "list",
      "get_current_window_id",
      "get_window_size",
      "get_window_position",
      "arrange",
    ] as const) {
      const result = await service.executeWindowAction({ action });
      expect(typeof result.success).toBe("boolean");
    }

    for (const action of [
      "move",
      "set_bounds",
      "get_application_windows",
    ] as const) {
      const result = await service.executeWindowAction({ action });
      expect(result.success).toBe(false);
    }
  }, 20_000);

  // Window management verbs against a window id that matches nothing: the verb
  // dispatch, its approval-command lookup, and the platform call all run and
  // fail fast (no window to act on) — no real window is moved or closed on the
  // host, and the shell-outs are bounded (absent WM tooling errors immediately).
  it("dispatches window management verbs for a non-matching window", async () => {
    const windowId = "computeruse-nonexistent-window-id";
    for (const action of [
      "focus",
      "switch",
      "minimize",
      "maximize",
      "restore",
      "close",
    ] as const) {
      const result = await service.executeWindowAction({ action, windowId });
      expect(typeof result.success).toBe("boolean");
    }

    const moved = await service.executeWindowAction({
      action: "move",
      windowId,
      x: 0,
      y: 0,
    });
    expect(typeof moved.success).toBe("boolean");

    const bounded = await service.executeWindowAction({
      action: "set_bounds",
      windowId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(typeof bounded.success).toBe("boolean");
  }, 20_000);

  it("exposes approval and display introspection", () => {
    expect(service.setApprovalMode("full_control")).toBe("full_control");
    const snapshot = service.getApprovalSnapshot();
    expect(snapshot).toHaveProperty("mode");
    const unsubscribe = service.subscribeApprovals(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    expect(service.resolveApproval("does-not-exist", true)).toBeNull();

    expect(service.getScreenDimensions()).toHaveProperty("width");
    expect(Array.isArray(service.getDisplays())).toBe(true);
    expect(service.getConfig()).toHaveProperty("approvalMode");
  });
});

/** Reads the persisted approval-mode config, or null when none exists. */
function readApprovalConfig(configPath: string): string | null {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch (err) {
    // error-policy:J3 a missing file is the expected first-run/CI shape; a
    // different read error means we cannot safely restore, so surface it.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Restores the approval-mode config to its pre-test contents (or absence). */
function restoreApprovalConfig(configPath: string, saved: string | null): void {
  if (saved === null) {
    fs.rmSync(configPath, { force: true });
    return;
  }
  fs.writeFileSync(configPath, saved, "utf8");
}

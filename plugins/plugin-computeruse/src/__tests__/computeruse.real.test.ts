import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import { windowAction } from "../actions/window.js";
import computerUsePlugin from "../index.js";
import { ComputerUseService } from "../services/computer-use-service.js";

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    character: {},
    getSetting(key: string) {
      return settings[key];
    },
  } as IAgentRuntime;
}

async function waitForPendingApproval(
  service: ComputerUseService,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const snapshot = service.getApprovalSnapshot();
    if (snapshot.pendingApprovals[0]) {
      return snapshot.pendingApprovals[0].id;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a pending approval.");
}

describe("computer-use live parity", () => {
  let workspaceDir = "";
  let service: ComputerUseService;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "computeruse-live-"));
    service = (await ComputerUseService.start(
      createRuntime({
        COMPUTER_USE_APPROVAL_MODE: "full_control",
      }),
    )) as ComputerUseService;
  });

  afterEach(async () => {
    await service.stop();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("exports the full public action surface", () => {
    const actionNames = computerUsePlugin.actions?.map((action) => action.name);
    expect(actionNames).toContain("COMPUTER_USE");
    expect(actionNames).toContain("WINDOW");
    expect(actionNames).not.toContain("DESKTOP");
    expect(useComputerAction.similes).toContain("USE_COMPUTER");
    expect(useComputerAction.roleGate).toMatchObject({ minRole: "OWNER" });
    expect(windowAction.similes).toEqual(
      expect.arrayContaining([
        "MANAGE_WINDOW",
        "WINDOW",
        "USE_WINDOW",
      ]),
    );
  });

  it("publishes the COMPUTER_USE desktop action surface and WINDOW action enum", () => {
    const desktopActions = useComputerAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(desktopActions?.schema).toMatchObject({
      enum: expect.arrayContaining([
        "screenshot",
        "click",
        "click_with_modifiers",
        "double_click",
        "right_click",
        "mouse_move",
        "type",
        "key",
        "key_combo",
        "scroll",
        "drag",
        "detect_elements",
        "ocr",
      ]),
    });

    const windowOp = windowAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(windowOp?.schema).toMatchObject({
      enum: expect.arrayContaining([
        "list",
        "focus",
        "switch",
        "arrange",
        "move",
        "minimize",
        "maximize",
        "restore",
        "close",
      ]),
    });
  });

  it("supports file commands and upstream path/edit aliases live", async () => {
    const filePath = path.join(workspaceDir, "notes.txt");
    const subdir = path.join(workspaceDir, "subdir");
    const nestedFilePath = path.join(subdir, "nested.txt");

    const writeResult = await service.executeCommand("file_write", {
      filepath: filePath,
      content: "hello",
    });
    expect(writeResult.success).toBe(true);

    const editResult = await service.executeCommand("file_edit", {
      filepath: filePath,
      find: "hello",
      replace: "world",
    });
    expect(editResult.success).toBe(true);

    const appendResult = await service.executeCommand("file_append", {
      path: filePath,
      content: "!",
    });
    expect(appendResult.success).toBe(true);

    const readResult = await service.executeCommand("file_read", {
      path: filePath,
    });
    expect(readResult.success).toBe(true);
    expect(readResult).toMatchObject({ content: "world!" });

    const existsResult = await service.executeCommand("file_exists", {
      path: filePath,
    });
    expect(existsResult).toMatchObject({
      success: true,
      exists: true,
      isFile: true,
    });

    const listResult = await service.executeCommand("directory_list", {
      dirpath: workspaceDir,
    });
    expect(listResult.success).toBe(true);
    expect(listResult.items?.some((entry) => entry.name === "notes.txt")).toBe(
      true,
    );

    const uploadPath = path.join(workspaceDir, "upload.txt");
    const uploadResult = await service.executeCommand("file_upload", {
      filepath: uploadPath,
      content: "upload",
    });
    expect(uploadResult.success).toBe(true);

    const downloadResult = await service.executeCommand("file_download", {
      filepath: uploadPath,
    });
    expect(downloadResult).toMatchObject({
      success: true,
      content: "upload",
    });

    const nestedWriteResult = await service.executeCommand("file_write", {
      filepath: nestedFilePath,
      content: "nested",
    });
    expect(nestedWriteResult.success).toBe(true);

    const deleteFileResult = await service.executeCommand("file_delete", {
      path: uploadPath,
    });
    expect(deleteFileResult.success).toBe(true);

    const deleteDirectoryResult = await service.executeCommand(
      "directory_delete",
      {
        dirpath: subdir,
      },
    );
    expect(deleteDirectoryResult.success).toBe(true);
  });

  it("supports terminal commands and blocks catastrophic commands live", async () => {
    const connectResult = await service.executeCommand("terminal_connect", {
      cwd: workspaceDir,
    });
    expect(connectResult.success).toBe(true);
    const sessionId = connectResult.sessionId;
    expect(sessionId).toBeTruthy();

    const executeResult = await service.executeCommand("execute_command", {
      session_id: sessionId,
      command: "printf 'live-terminal' > terminal.txt",
    });
    expect(executeResult.success).toBe(true);

    expect(
      await readFile(path.join(workspaceDir, "terminal.txt"), "utf8"),
    ).toBe("live-terminal");

    const readResult = await service.executeCommand("terminal_read", {
      session_id: sessionId,
    });
    expect(readResult.success).toBe(true);

    const typeResult = await service.executeCommand("terminal_type", {
      text: "echo from parity",
    });
    expect(typeResult.success).toBe(true);

    const clearResult = await service.executeCommand("terminal_clear", {
      session_id: sessionId,
    });
    expect(clearResult.success).toBe(true);

    const blockedResult = await service.executeCommand("terminal_execute", {
      command: "rm -rf /",
    });
    expect(blockedResult.success).toBe(false);
    expect(blockedResult.error).toContain("Command blocked");

    const closeResult = await service.executeCommand("terminal_close", {
      session_id: sessionId,
    });
    expect(closeResult.success).toBe(true);
  });

  it("supports browser commands, aliases, and tab management live", async () => {
    const capabilities = service.getCapabilities();
    if (!capabilities.browser.available) {
      return;
    }

    // GitHub Actions ubuntu runners detect Chrome on PATH but Chromium fails
    // to actually launch under the runner sandbox despite --no-sandbox args,
    // so skip this live browser flow on CI until a headed-or-docker strategy
    // is in place. Local dev and dev desktop still exercise this path.
    if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      return;
    }

    const pageUrl =
      "data:text/html,<html><body data-ready='yes'><button id='go'>Go</button><a href='#next'>Next</a><div>Ready</div></body></html>";

    const openResult = await service.executeCommand("browser_connect", {
      url: pageUrl,
    });
    if (!openResult.success) {
      throw new Error(
        `browser_connect failed locally: ${String(openResult.error ?? "unknown")}`,
      );
    }
    expect(openResult.success).toBe(true);

    const domResult = await service.executeCommand("browser_get_dom");
    expect(domResult.success).toBe(true);
    expect(domResult.content).toContain("data-ready");

    const clickablesResult = await service.executeCommand(
      "browser_get_clickables",
    );
    expect(clickablesResult.success).toBe(true);
    expect(Array.isArray(clickablesResult.data)).toBe(true);

    const stateResult = await service.executeCommand("browser_state");
    expect(stateResult.success).toBe(true);

    const infoResult = await service.executeCommand("browser_info");
    expect(infoResult.success).toBe(true);

    const contextResult = await service.executeCommand("browser_get_context");
    expect(contextResult.success).toBe(true);

    const waitResult = await service.executeCommand("browser_wait", {
      selector: "#go",
      timeout: 2000,
    });
    expect(waitResult.success).toBe(true);

    const openTabResult = await service.executeCommand("browser_open_tab", {
      url: "data:text/html,<html><body>Tab 2</body></html>",
    });
    expect(openTabResult.success).toBe(true);

    const tabsResult = await service.executeCommand("browser_list_tabs");
    expect(tabsResult.success).toBe(true);
    expect(Array.isArray(tabsResult.data)).toBe(true);
    expect((tabsResult.data as Array<unknown>).length).toBeGreaterThanOrEqual(
      2,
    );

    const switchTabResult = await service.executeCommand("browser_switch_tab", {
      tab_index: 0,
    });
    expect(switchTabResult.success).toBe(true);

    const closeTabResult = await service.executeCommand("browser_close_tab", {
      tab_index: 1,
    });
    expect(closeTabResult.success).toBe(true);

    const screenshotResult = await service.executeCommand("browser_screenshot");
    expect(screenshotResult.success).toBe(true);
    expect(typeof screenshotResult.screenshot).toBe("string");

    const closeResult = await service.executeCommand("browser_close");
    expect(closeResult.success).toBe(true);
  });

  it("reports screenshot and desktop permission outcomes live", async () => {
    if (!service.getCapabilities().screenshot.available) {
      return;
    }

    const screenshotResult = await service.executeDesktopAction({
      action: "screenshot",
    });
    if (screenshotResult.success) {
      expect(screenshotResult.screenshot).toBeTruthy();
    } else {
      expect(screenshotResult.permissionDenied).toBe(true);
      expect(screenshotResult.permissionType).toBe("screen_recording");
    }

    const detectResult = await service.executeDesktopAction({
      action: "detect_elements",
    });
    expect(detectResult.success).toBe(false);
    expect(detectResult.error).toContain("not available");

    const ocrResult = await service.executeDesktopAction({ action: "ocr" });
    expect(ocrResult.success).toBe(false);
    expect(ocrResult.error).toContain("not available");

    const computerUseCapability = service.getCapabilities().computerUse;
    if (!computerUseCapability.available) {
      return;
    }

    const moveResult = await service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [1, 1],
    });
    if (moveResult.success) {
      expect(moveResult.success).toBe(true);
    } else if (
      process.platform === "darwin" &&
      !computerUseCapability.tool.includes("cliclick")
    ) {
      expect(moveResult.error).toContain("mouse_move requires cliclick");
    } else if (moveResult.permissionDenied) {
      expect(moveResult.permissionType).toBe("accessibility");
    } else {
      expect(
        (typeof moveResult.error === "string" && moveResult.error.length > 0) ||
          moveResult.permissionDenied === true ||
          moveResult.permissionType === "accessibility",
      ).toBe(true);
    }
  });

  it("supports window listing and rejects incomplete window move commands live", async () => {
    const listResult = await service.executeCommand("list_windows");
    expect(listResult.success).toBe(true);
    expect(Array.isArray(listResult.windows)).toBe(true);

    const moveResult = await service.executeCommand("move_window", {
      x: 10,
      y: 20,
    });
    expect(moveResult.success).toBe(false);
    expect(moveResult.error).toMatch(/windowId or windowTitle is required/i);
  });

  it("honors approval mode and safe-command auto-approval live", async () => {
    const filePath = path.join(workspaceDir, "approval.txt");
    await service.executeCommand("file_write", {
      path: filePath,
      content: "approval",
    });

    const approveAllService = (await ComputerUseService.start(
      createRuntime({
        COMPUTER_USE_APPROVAL_MODE: "approve_all",
      }),
    )) as ComputerUseService;

    try {
      const pendingRead = approveAllService.executeCommand("file_read", {
        path: filePath,
      });
      const approvalId = await waitForPendingApproval(approveAllService);
      const snapshot = approveAllService.getApprovalSnapshot();
      expect(snapshot.pendingApprovals[0]?.command).toBe("file_read");
      approveAllService.resolveApproval(approvalId, true);
      const approvedResult = await pendingRead;
      expect(approvedResult.success).toBe(true);
    } finally {
      await approveAllService.stop();
    }

    const smartApproveService = (await ComputerUseService.start(
      createRuntime({
        COMPUTER_USE_APPROVAL_MODE: "smart_approve",
      }),
    )) as ComputerUseService;

    try {
      const safeRead = await smartApproveService.executeCommand("file_read", {
        path: filePath,
      });
      expect(safeRead.success).toBe(true);
      expect(smartApproveService.getApprovalSnapshot().pendingCount).toBe(0);
    } finally {
      await smartApproveService.stop();
    }
  });
});

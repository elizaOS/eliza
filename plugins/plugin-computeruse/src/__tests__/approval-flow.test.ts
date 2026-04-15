import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerUseService } from "../services/computer-use-service.js";

function createMockRuntime(
  settings: Record<string, string> = {},
): IAgentRuntime {
  return {
    character: {},
    getSetting(key: string) {
      return settings[key] ?? undefined;
    },
    getService() {
      return null;
    },
  } as unknown as IAgentRuntime;
}

describe("ComputerUseService approval flow", () => {
  let service: ComputerUseService;
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "computeruse-approval-"));
    filePath = join(tempDir, "sample.txt");
    await writeFile(filePath, "approval-flow", "utf8");
    service = (await ComputerUseService.start(
      createMockRuntime({
        COMPUTER_USE_APPROVAL_MODE: "approve_all",
      }),
    )) as ComputerUseService;
  });

  afterEach(async () => {
    await service.stop();
  });

  it("waits for approval and then completes the queued command", async () => {
    const pendingResult = service.executeFileAction({
      action: "read",
      path: filePath,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = service.getApprovalSnapshot();
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.pendingApprovals[0]?.command).toBe("file_read");
    expect(snapshot.pendingApprovals[0]?.parameters.path).toBe(filePath);

    const resolution = service.resolveApproval(
      snapshot.pendingApprovals[0]!.id,
      true,
      "looks safe",
    );
    expect(resolution?.approved).toBe(true);

    const result = await pendingResult;
    expect(result.success).toBe(true);
    expect(result.content).toBe("approval-flow");
  });

  it("returns a rejection result when the pending approval is denied", async () => {
    const pendingResult = service.executeFileAction({
      action: "read",
      path: filePath,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = service.getApprovalSnapshot();
    const resolution = service.resolveApproval(
      snapshot.pendingApprovals[0]!.id,
      false,
      "user rejected it",
    );
    expect(resolution?.approved).toBe(false);

    const result = await pendingResult;
    expect(result.success).toBe(false);
    expect(result.error).toContain("user rejected it");
  });
});

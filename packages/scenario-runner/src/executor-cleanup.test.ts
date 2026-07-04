/**
 * Verifies `runScenario` tears down side effects it starts — here, that any
 * website-blocker self-control block opened during a scenario is reconciled and
 * cleared afterward, using the real plugin-blocker service.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  reconcileSelfControlBlockState,
  resetSelfControlStatusCache,
  startSelfControlBlock,
} from "@elizaos/plugin-blocker/services/website-blocker/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

function createRuntime(): AgentRuntime {
  return {
    actions: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

function createHostsFile(): { dir: string; hostsFilePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-cleanup-"));
  const hostsFilePath = path.join(dir, "hosts");
  fs.writeFileSync(
    hostsFilePath,
    ["127.0.0.1 localhost", "::1 localhost", ""].join("\n"),
    "utf8",
  );
  return { dir, hostsFilePath };
}

const previousWebsiteBlockerHostsFilePath =
  process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
const previousSelfControlHostsFilePath =
  process.env.SELFCONTROL_HOSTS_FILE_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  resetSelfControlStatusCache();
  if (previousWebsiteBlockerHostsFilePath !== undefined) {
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH =
      previousWebsiteBlockerHostsFilePath;
  } else {
    delete process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH;
  }
  if (previousSelfControlHostsFilePath !== undefined) {
    process.env.SELFCONTROL_HOSTS_FILE_PATH = previousSelfControlHostsFilePath;
  } else {
    delete process.env.SELFCONTROL_HOSTS_FILE_PATH;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scenario cleanup", () => {
  it("clears self-control website blocks from the scenario hosts file", async () => {
    const { dir, hostsFilePath } = createHostsFile();
    tempDirs.push(dir);
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = hostsFilePath;
    process.env.SELFCONTROL_HOSTS_FILE_PATH = hostsFilePath;
    resetSelfControlStatusCache();

    const start = await startSelfControlBlock({
      websites: ["x.com"],
      durationMinutes: 30,
      metadata: { profile: "unit-cleanup" },
    });

    expect(start.success).toBe(true);
    expect((await reconcileSelfControlBlockState()).active).toBe(true);

    const report = await runScenario(
      {
        id: "selfcontrol-cleanup",
        title: "Self-control cleanup",
        domain: "executor",
        turns: [],
        cleanup: [
          {
            type: "selfControlClearBlocks",
            profile: "unit-cleanup",
          },
        ],
      },
      createRuntime(),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect((await reconcileSelfControlBlockState()).active).toBe(false);
  });

  it("reports cleanup failure when the self-control hosts file is unavailable", async () => {
    const { dir, hostsFilePath } = createHostsFile();
    tempDirs.push(dir);
    fs.rmSync(hostsFilePath, { force: true });
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH = hostsFilePath;
    process.env.SELFCONTROL_HOSTS_FILE_PATH = hostsFilePath;
    resetSelfControlStatusCache();

    const report = await runScenario(
      {
        id: "selfcontrol-cleanup-missing-hosts",
        title: "Self-control cleanup missing hosts",
        domain: "executor",
        turns: [],
        cleanup: [
          {
            type: "selfControlClearBlocks",
            name: "clear self-control",
          },
        ],
      },
      createRuntime(),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toContainEqual({
      label: "cleanup",
      detail: expect.stringContaining("cleanup clear self-control"),
    });
    expect(report.failedAssertions[0]?.detail).toContain(
      "selfControlClearBlocks failed",
    );
  });

  it("runs custom cleanup even when scenario execution throws", async () => {
    let cleanedUp = false;

    const report = await runScenario(
      {
        id: "custom-cleanup-after-throw",
        title: "Custom cleanup after throw",
        domain: "executor",
        turns: [
          {
            kind: "message",
            name: "missing-message-service",
            text: "This turn should throw before normal completion.",
          },
        ],
        cleanup: [
          {
            type: "custom",
            name: "mark-cleaned",
            apply: () => {
              cleanedUp = true;
              return undefined;
            },
          },
        ],
      },
      createRuntime(),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("runtime.messageService is not initialized");
    expect(cleanedUp).toBe(true);
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, Service } from "@elizaos/core";

import { FileStateService } from "../services/file-state-service.js";
import { SandboxService } from "../services/sandbox-service.js";
import { FILE_STATE_SERVICE, SANDBOX_SERVICE } from "../types.js";

export interface TestEnv {
  runtime: IAgentRuntime;
  fileState: FileStateService;
  sandbox: SandboxService;
  message: Memory;
  tmpDir: string;
  /**
   * Absolute path the SandboxService is configured to refuse. Tests can
   * read/write under this path to verify blocklist enforcement. Lives inside
   * tmpDir so it's removed automatically by `cleanup`.
   */
  blockedPath: string;
  cleanup: () => Promise<void>;
}

export async function makeTempDir(prefix: string): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return await fs.realpath(created);
}

export interface SetupOptions {
  /** Optional pre-existing tmp dir to use instead of mkdtemp. */
  rootsPath?: string;
  /** Additional runtime settings to merge in. */
  extraSettings?: Record<string, unknown>;
  /** Override the blocked path; defaults to <tmpDir>/_blocked. */
  blockedPath?: string;
}

export async function setupEnv(
  prefix: string,
  options: SetupOptions = {},
): Promise<TestEnv> {
  const tmpDir = options.rootsPath ?? (await makeTempDir(prefix));
  const blockedPath = options.blockedPath ?? path.join(tmpDir, "_blocked");
  await fs.mkdir(blockedPath, { recursive: true });

  const settings: Record<string, unknown> = {
    CODING_TOOLS_BLOCKED_PATHS: blockedPath,
    ...options.extraSettings,
  };

  const services = new Map<string, Service>();
  const runtime = {
    agentId: "test-agent",
    getSetting: (key: string) => settings[key],
    getService: (key: string) => services.get(key) ?? null,
  } as unknown as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const fileState = await FileStateService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(FILE_STATE_SERVICE, fileState);

  const message = {
    roomId: "test-room",
    entityId: "test-entity",
  } as unknown as Memory;

  return {
    runtime,
    fileState,
    sandbox,
    message,
    tmpDir,
    blockedPath,
    cleanup: async () => {
      await sandbox.stop();
      await fileState.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

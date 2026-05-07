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
  cleanup: () => Promise<void>;
}

export async function makeTempDir(prefix: string): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  // realpath on macOS resolves /var → /private/var; downstream code uses
  // realpath for sandbox checks, so the tests must use the realpath form.
  return await fs.realpath(created);
}

export interface SetupOptions {
  rootsPath?: string;
  extraSettings?: Record<string, unknown>;
}

export async function setupEnv(
  prefix: string,
  options: SetupOptions = {},
): Promise<TestEnv> {
  const tmpDir = options.rootsPath ?? (await makeTempDir(prefix));
  const settings: Record<string, unknown> = {
    CODING_TOOLS_WORKSPACE_ROOTS: tmpDir,
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
    cleanup: async () => {
      await sandbox.stop();
      await fileState.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

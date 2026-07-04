/**
 * Unit tests for the E2B sandbox factory service contract.
 *
 * The E2B SDK boundary is faked while service registration, entry-type
 * normalization, delegated file operations, command execution, and sandbox
 * teardown behavior run through the real adapter code.
 */

import {
  E2B_SANDBOX_FACTORY_SERVICE_TYPE,
  type SandboxCommandRunOptions,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  E2BSandboxFactoryService,
  E2BSandboxSdkClient,
  e2bSandboxPlugin,
} from "../index";

type FakeSdkEntry = {
  path: string;
  name: string;
  type?: string;
  size?: number;
  mode?: number;
  modifiedTime?: Date;
};

function fakeSdkSandbox(entries: FakeSdkEntry[] = []) {
  return {
    sandboxId: "sbx_fake",
    files: {
      list: vi.fn(async () => entries),
      read: vi.fn(async () => "file text"),
      write: vi.fn(async (path: string) => ({
        path,
        name: path.split("/").pop() ?? path,
      })),
    },
    commands: {
      run: vi.fn(async (cmd: string, _opts?: SandboxCommandRunOptions) => ({
        exitCode: 0,
        stdout: `ran ${cmd}`,
        stderr: "",
      })),
    },
    kill: vi.fn(async () => true),
  };
}

describe("plugin-e2b-sandbox", () => {
  it("registers its service under the shared factory service type", () => {
    expect(E2BSandboxFactoryService.serviceType).toBe(
      E2B_SANDBOX_FACTORY_SERVICE_TYPE,
    );
    expect(e2bSandboxPlugin.name).toBe("e2b-sandbox");
    expect(e2bSandboxPlugin.services).toContain(E2BSandboxFactoryService);
  });

  it("exposes a capability description and a no-op stop", async () => {
    const runtime = { agentId: "a" } as never;
    const service = await E2BSandboxFactoryService.start(runtime);
    expect(typeof service.capabilityDescription).toBe("string");
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("normalizes sandbox entry types and preserves optional fields on list", async () => {
    const sandbox = fakeSdkSandbox([
      {
        path: "/workspace/src",
        name: "src",
        type: "directory",
        size: 0,
        mode: 0o755,
        modifiedTime: new Date("2026-01-01T00:00:00.000Z"),
      },
      { path: "/workspace/a.txt", name: "a.txt", type: "file", size: 3 },
      { path: "/workspace/l", name: "l", type: "symlink" },
      { path: "/workspace/x", name: "x", type: "socket" },
    ]);
    const client = new E2BSandboxSdkClient(sandbox as never);

    expect(client.sandboxId).toBe("sbx_fake");
    const entries = await client.files.list("/workspace");
    expect(entries.map((entry) => entry.type)).toEqual([
      "dir",
      "file",
      "symlink",
      "other",
    ]);
    expect(entries[0]).toMatchObject({ name: "src", mode: 0o755, size: 0 });
    expect(entries[0]?.modifiedTime).toEqual(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // Missing size defaults to 0.
    expect(entries[2]?.size).toBe(0);
  });

  it("delegates read/write/command to the underlying sandbox and awaits kill", async () => {
    const sandbox = fakeSdkSandbox();
    const client = new E2BSandboxSdkClient(sandbox as never);

    await client.files.write("/workspace/out.txt", "hi");
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/workspace/out.txt",
      "hi",
      undefined,
    );

    const command = await client.commands.run("echo hi");
    expect(command).toMatchObject({ exitCode: 0, stdout: "ran echo hi" });

    await client.kill({ requestTimeoutMs: 1000 });
    expect(sandbox.kill).toHaveBeenCalledWith({ requestTimeoutMs: 1000 });
  });
});

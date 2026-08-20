/** Tests the per-conversation cwd stack and missing-directory recovery against the real filesystem. */
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCwdService } from "./session-cwd-service.js";

function runtimeStub(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: (key: string) => settings[key],
    getService: () => null,
  } as IAgentRuntime;
}

describe("SessionCwdService", () => {
  let service: SessionCwdService;

  beforeEach(async () => {
    service = await SessionCwdService.start(runtimeStub());
  });

  afterEach(async () => {
    await service.stop();
  });

  it("stores independent working directories by conversation", () => {
    const defaultCwd = path.resolve(process.cwd());
    expect(service.getCwd(undefined)).toBe(defaultCwd);
    expect(service.getCwd("fresh-room")).toBe(defaultCwd);

    service.setCwd("room-a", path.join(defaultCwd, "workspace-a"));
    service.setCwd("room-b", path.join(defaultCwd, "workspace-b"));

    expect(service.getCwd("room-a")).toBe(path.join(defaultCwd, "workspace-a"));
    expect(service.getCwd("room-b")).toBe(path.join(defaultCwd, "workspace-b"));
  });

  it("uses the runtime's explicit Eliza workspace for fresh conversations", async () => {
    const workspace = path.resolve(os.tmpdir());
    const configured = await SessionCwdService.start(
      runtimeStub({ ELIZA_WORKSPACE_DIR: workspace }),
    );
    try {
      expect(configured.defaultCwd()).toBe(workspace);
      expect(configured.getCwd("fresh-room")).toBe(workspace);
      await expect(configured.getExistingCwd("fresh-room")).resolves.toEqual({
        cwd: workspace,
        reset: false,
      });
    } finally {
      await configured.stop();
    }
  });

  it("uses a sole configured coding workspace root when no explicit workspace is set", async () => {
    const workspace = path.resolve(os.tmpdir());
    const configured = await SessionCwdService.start(
      runtimeStub({ CODING_TOOLS_WORKSPACE_ROOTS: workspace }),
    );
    try {
      expect(configured.defaultCwd()).toBe(workspace);
      expect(configured.getCwd("fresh-room")).toBe(workspace);
    } finally {
      await configured.stop();
    }
  });

  it("does not guess between multiple configured coding workspace roots", async () => {
    const configured = await SessionCwdService.start(
      runtimeStub({
        CODING_TOOLS_WORKSPACE_ROOTS: `${os.tmpdir()},${path.join(os.tmpdir(), "other")}`,
      }),
    );
    try {
      expect(configured.defaultCwd()).toBe(path.resolve(process.cwd()));
    } finally {
      await configured.stop();
    }
  });

  it("pushes and pops nested worktree frames in order", () => {
    const original = path.join(service.defaultCwd(), "original");
    const first = path.join(service.defaultCwd(), "first");
    const second = path.join(service.defaultCwd(), "second");
    service.setCwd("room", original);

    expect(service.pushWorktree("room", first)).toBe(first);
    expect(service.pushWorktree("room", second)).toBe(second);
    expect(service.getCwd("room")).toBe(second);
    expect(service.popWorktree("room")).toEqual({
      entered: second,
      previousCwd: first,
    });
    expect(service.popWorktree("room")).toEqual({
      entered: first,
      previousCwd: original,
    });
    expect(service.popWorktree("room")).toBeUndefined();
    expect(service.getCwd("room")).toBe(original);
  });

  it("keeps an existing cwd and resets a missing cwd observably", async () => {
    service.setCwd("existing", os.tmpdir());
    await expect(service.getExistingCwd("existing")).resolves.toEqual({
      cwd: path.resolve(os.tmpdir()),
      reset: false,
    });

    const missing = path.join(
      os.tmpdir(),
      `eliza-session-cwd-missing-${randomUUID()}`,
    );
    service.setCwd("missing", missing);
    await expect(service.getExistingCwd("missing")).resolves.toEqual({
      cwd: service.defaultCwd(),
      previousCwd: path.resolve(missing),
      reset: true,
    });
    expect(service.getCwd("missing")).toBe(service.defaultCwd());
  });
});

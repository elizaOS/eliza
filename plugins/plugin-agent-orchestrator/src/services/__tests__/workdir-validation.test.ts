import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async (p: string) => p),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  realpath: mocks.realpath,
}));
vi.mock("node:os", () => ({ homedir: () => "/home/test" }));

import {
  ensureTaskWorkdir,
  resolveAllowedWorkdir,
} from "./workdir-validation.ts";

describe("ensureTaskWorkdir", () => {
  it("creates the task workspace under the eliza workspaces dir", async () => {
    const dir = await ensureTaskWorkdir("task-42");
    expect(dir).toBe("/home/test/.eliza/workspaces/task-42");
    expect(mocks.mkdir).toHaveBeenCalledWith(
      "/home/test/.eliza/workspaces/task-42",
      { recursive: true },
    );
  });
});

describe("resolveAllowedWorkdir", () => {
  it("accepts the default workspaces dir", async () => {
    mocks.realpath.mockImplementation(async (p: string) => p);
    const result = await resolveAllowedWorkdir(
      "/home/test/.eliza/workspaces/task-1",
    );
    expect(result).toBeTruthy();
  });

  it("rejects paths outside the allowed roots", async () => {
    // 返回一个明显非法的目录（isInside 检查应拒绝）
    const result = await resolveAllowedWorkdir("/etc/passwd").catch(
      (e: Error) => e,
    );
    expect(result).toBeInstanceOf(Error);
  });
});

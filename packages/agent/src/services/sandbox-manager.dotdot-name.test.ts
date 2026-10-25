/** A workspace file named "..notes" maps into the container workdir. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxManager } from "./sandbox-manager.ts";

let workspaceRoot: string;

afterEach(async () => {
  if (workspaceRoot) {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  }
});

describe("sandbox workspace paths", () => {
  it("maps a file whose name starts with .. into the container", async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sandbox-dot-"));
    const manager = new SandboxManager({
      mode: "off",
      workspaceRoot,
      engineType: "docker",
    });

    expect(
      manager.getContainerWorkspacePath(path.join(workspaceRoot, "..notes")),
    ).toBe("/workspace/..notes");
    expect(
      manager.getContainerWorkspacePath(path.join(workspaceRoot, "notes")),
    ).toBe("/workspace/notes");
    expect(
      manager.getContainerWorkspacePath(
        path.resolve(workspaceRoot, "..", "outside"),
      ),
    ).toBe(null);
  });
});

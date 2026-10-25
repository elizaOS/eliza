/** A file whose name starts with ".." is inside the project root. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVirtualFilesystemService,
  VirtualFilesystemError,
} from "./virtual-filesystem.ts";

let stateDir: string;

afterEach(async () => {
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
});

describe("virtual filesystem dot-dot names", () => {
  it("writes and reads a file named ..notes", async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-dotdot-"));
    const vfs = createVirtualFilesystemService({
      projectId: "dotdot-name",
      stateDir,
    });

    await vfs.writeFile("..notes", "inside");

    expect(await vfs.readFile("..notes")).toBe("inside");
  });

  it("still rejects a parent-directory segment", async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-dotdot-"));
    const vfs = createVirtualFilesystemService({
      projectId: "dotdot-name",
      stateDir,
    });

    await expect(vfs.writeFile("../outside", "no")).rejects.toBeInstanceOf(
      VirtualFilesystemError,
    );
  });
});

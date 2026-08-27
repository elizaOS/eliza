/** Simulates Android SELinux EACCES on platform ancestors without a physical device. */
import { lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  denyUnownedDirectoryOpen: false,
}));

function permissionDeniedOpen(target: string): NodeJS.ErrnoException {
  const error = new Error(
    `EACCES: permission denied, open '${target}'`,
  ) as NodeJS.ErrnoException;
  error.code = "EACCES";
  error.errno = -13;
  error.syscall = "open";
  error.path = target;
  return error;
}

function isUnownedDirectory(target: string): boolean {
  const runtimeUid = process.getuid?.();
  if (runtimeUid === undefined) return false;
  try {
    const stat = lstatSync(target);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      Number(stat.uid) !== runtimeUid
    );
  } catch {
    return false;
  }
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      if (faults.denyUnownedDirectoryOpen && isUnownedDirectory(target)) {
        throw permissionDeniedOpen(target);
      }
      return await actual.open(...args);
    },
  };
});

const { loadOrCreateRuntimeInstallationId } = await import(
  "./runtime-installation-id.ts"
);

const cleanup: string[] = [];

afterEach(async () => {
  faults.denyUnownedDirectoryOpen = false;
  await Promise.all(
    cleanup
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runtime installation identity Android SELinux ancestors", () => {
  it("loads identity when Android platform ancestors refuse directory descriptors", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-android-eacces-"),
    );
    cleanup.push(root);
    const state = path.join(root, "files", ".eliza");
    await fs.mkdir(path.dirname(state), { recursive: true, mode: 0o700 });
    faults.denyUnownedDirectoryOpen = true;
    await expect(
      loadOrCreateRuntimeInstallationId(state, {
        runtimeBoundary: "android",
      }),
    ).resolves.toMatch(/^[a-f0-9-]{36}$/);
  });

  it("still rejects a mutable Android state boundary when platform ancestors return EACCES", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-android-mutable-"),
    );
    const hostileParent = path.join(root, "hostile");
    cleanup.push(root);
    await fs.mkdir(hostileParent, { mode: 0o777 });
    await fs.chmod(hostileParent, 0o777);
    faults.denyUnownedDirectoryOpen = true;
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(hostileParent, "state"), {
        runtimeBoundary: "android",
      }),
    ).rejects.toThrow("replaceable by another user");
    await expect(
      fs.access(path.join(hostileParent, "state")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps POSIX fail-closed when unowned ancestors refuse directory descriptors", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-posix-eacces-"),
    );
    cleanup.push(root);
    faults.denyUnownedDirectoryOpen = true;
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toMatchObject(
      {
        code: "EACCES",
      },
    );
  });
});

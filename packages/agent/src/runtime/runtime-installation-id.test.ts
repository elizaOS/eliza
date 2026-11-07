/** Exercises the POSIX runtime installation identity across first boots that stop or overlap. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOrCreateRuntimeInstallationId } from "./runtime-installation-id.ts";

const fsHooks = vi.hoisted(() => ({
  afterLink: undefined as (() => Promise<void>) | undefined,
  beforeOpendir: undefined as (() => Promise<void>) | undefined,
}));

// Runs the other boot's step at an exact point of this one: after link()
// published a candidate, or before the state directory is listed.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      const afterLink = fsHooks.afterLink;
      fsHooks.afterLink = undefined;
      await afterLink?.();
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const beforeOpendir = fsHooks.beforeOpendir;
      fsHooks.beforeOpendir = undefined;
      await beforeOpendir?.();
      return await actual.opendir(...args);
    },
  };
});

const roots = new Set<string>();

async function stateDirectory(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "runtime-installation-id-"),
  );
  roots.add(root);
  return path.join(root, "state");
}

afterEach(async () => {
  fsHooks.afterLink = undefined;
  fsHooks.beforeOpendir = undefined;
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

describe.skipIf(process.platform === "win32")(
  "runtime installation identity",
  () => {
    it("keeps the id when a first boot stopped between link and cleanup", async () => {
      const directory = await stateDirectory();
      const id = await loadOrCreateRuntimeInstallationId(directory);
      const target = path.join(directory, "runtime-installation-id");
      // The state a process leaves when it dies after link(temporary, target)
      // and before it unlinks the temporary name.
      const candidate = path.join(
        directory,
        `.runtime-installation-id.${randomUUID()}.tmp`,
      );
      await fs.link(target, candidate);

      await expect(loadOrCreateRuntimeInstallationId(directory)).resolves.toBe(
        id,
      );
      await expect(fs.lstat(candidate)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await fs.lstat(target)).nlink).toBe(1);
    });

    it("reads the id when the other boot unlinks its candidate first", async () => {
      const directory = await stateDirectory();
      const id = await loadOrCreateRuntimeInstallationId(directory);
      const target = path.join(directory, "runtime-installation-id");
      const candidate = path.join(
        directory,
        `.runtime-installation-id.${randomUUID()}.tmp`,
      );
      await fs.link(target, candidate);
      // The publishing boot finishes its own cleanup after this boot saw two
      // links and before it lists the directory.
      fsHooks.beforeOpendir = async () => {
        await fs.unlink(candidate);
      };

      await expect(loadOrCreateRuntimeInstallationId(directory)).resolves.toBe(
        id,
      );
      expect(fsHooks.beforeOpendir).toBeUndefined();
    });

    it("still refuses another link and keeps a candidate name of another file", async () => {
      const directory = await stateDirectory();
      await loadOrCreateRuntimeInstallationId(directory);
      const target = path.join(directory, "runtime-installation-id");
      const other = path.join(directory, "runtime-installation-id.copy");
      await fs.link(target, other);
      const unrelated = path.join(
        directory,
        `.runtime-installation-id.${randomUUID()}.tmp`,
      );
      await fs.writeFile(unrelated, `${randomUUID()}\n`, { mode: 0o600 });

      await expect(
        loadOrCreateRuntimeInstallationId(directory),
      ).rejects.toThrow(
        "Runtime installation identity must not have multiple links.",
      );
      expect((await fs.lstat(other)).nlink).toBe(2);
      expect((await fs.lstat(unrelated)).isFile()).toBe(true);
    });

    it("gives a boot that reads during another boot's publish the same id", async () => {
      const directory = await stateDirectory();
      let overlapping: Promise<string> | undefined;
      fsHooks.afterLink = async () => {
        overlapping = loadOrCreateRuntimeInstallationId(directory);
        await overlapping.catch(() => undefined);
      };

      const id = await loadOrCreateRuntimeInstallationId(directory);

      expect(overlapping).toBeDefined();
      await expect(overlapping).resolves.toBe(id);
      const names = await fs.readdir(directory);
      expect(names).toEqual(["runtime-installation-id"]);
    });
  },
);

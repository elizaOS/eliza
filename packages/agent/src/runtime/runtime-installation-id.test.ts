/** Exercises durable runtime installation identity against real temporary directories. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __createRuntimeInstallationIdLoaderForTests,
  constructWithRuntimeInstallationIdentity,
  loadOrCreateRuntimeInstallationId,
  RuntimeInstallationIdentityUnsupportedError,
} from "./runtime-installation-id.ts";

const cleanup: string[] = [];

async function expectNoIdentityArtifacts(directory: string): Promise<void> {
  const names = await fs.readdir(directory);
  expect(
    names.filter(
      (name) =>
        name === "runtime-installation-id" ||
        name.startsWith(".runtime-installation-id."),
    ),
  ).toEqual([]);
}

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runtime installation identity", () => {
  it("survives host reconstruction and concurrent boot in one state directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-owner-one-"));
    cleanup.push(root);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateRuntimeInstallationId(root)),
    );
    expect(new Set(concurrent)).toHaveLength(1);
    expect(await loadOrCreateRuntimeInstallationId(root)).toBe(concurrent[0]);
    expect(
      (await fs.stat(path.join(root, "runtime-installation-id"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("gives independent installations distinct identities", async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-owner-a-"));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-owner-b-"));
    cleanup.push(first, second);
    expect(await loadOrCreateRuntimeInstallationId(first)).not.toBe(
      await loadOrCreateRuntimeInstallationId(second),
    );
  });

  it("fails closed when a persisted identity is corrupt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-owner-bad-"));
    cleanup.push(root);
    await fs.writeFile(
      path.join(root, "runtime-installation-id"),
      "not-a-uuid\n",
    );
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "Runtime installation identity is corrupt",
    );
  });

  it("repairs a valid identity whose permissions are too broad", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-mode-"),
    );
    cleanup.push(root);
    const expected = await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    await fs.chmod(target, 0o644);
    await expect(loadOrCreateRuntimeInstallationId(root)).resolves.toBe(
      expected,
    );
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it("rejects symlink and nonregular identity paths", async () => {
    const symlinkRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-link-"),
    );
    const directoryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-nonregular-"),
    );
    const external = path.join(symlinkRoot, "external");
    cleanup.push(symlinkRoot, directoryRoot);
    await fs.writeFile(external, "55555555-5555-4555-8555-555555555555\n");
    await fs.symlink(
      external,
      path.join(symlinkRoot, "runtime-installation-id"),
    );
    await fs.mkdir(path.join(directoryRoot, "runtime-installation-id"));
    await expect(
      loadOrCreateRuntimeInstallationId(symlinkRoot),
    ).rejects.toThrow("must be a regular file");
    await expect(
      loadOrCreateRuntimeInstallationId(directoryRoot),
    ).rejects.toThrow("must be a regular file");
  });

  it("rejects symlinked and attacker-writable state directories", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-dir-"),
    );
    const real = path.join(parent, "real");
    const linked = path.join(parent, "linked");
    const hostile = path.join(parent, "hostile");
    cleanup.push(parent);
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, linked);
    await fs.mkdir(hostile, { mode: 0o777 });
    await fs.chmod(hostile, 0o777);
    await expect(loadOrCreateRuntimeInstallationId(linked)).rejects.toThrow(
      "must be a real directory",
    );
    await expect(loadOrCreateRuntimeInstallationId(hostile)).rejects.toThrow(
      "writable by another user",
    );
  });

  it("rejects symlinked and attacker-writable state parents", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-parent-"),
    );
    const hostileParent = path.join(root, "hostile");
    const realParent = path.join(root, "real");
    const linkedParent = path.join(root, "linked");
    cleanup.push(root);
    await fs.mkdir(hostileParent, { mode: 0o777 });
    await fs.chmod(hostileParent, 0o777);
    await fs.mkdir(realParent, { mode: 0o700 });
    await fs.symlink(realParent, linkedParent);
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(hostileParent, "state")),
    ).rejects.toThrow("replaceable by another user");
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(linkedParent, "state")),
    ).rejects.toThrow("parent must be a real directory");
  });

  it("accepts a trusted pre-existing state directory", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-existing-"),
    );
    cleanup.push(root);
    await fs.chmod(root, 0o755);
    await expect(loadOrCreateRuntimeInstallationId(root)).resolves.toMatch(
      /^[a-f0-9-]{36}$/,
    );
  });

  it("rechecks cancellation after delayed identity I/O before construction", async () => {
    const controller = new AbortController();
    let release: ((value: UUID) => void) | undefined;
    const load = vi.fn(
      async () =>
        await new Promise<UUID>((resolve) => {
          release = resolve;
        }),
    );
    const construct = vi.fn(() => ({ constructed: true }));
    const pending = constructWithRuntimeInstallationIdentity({
      stateDirectory: "/unused",
      abortSignal: controller.signal,
      load,
      construct,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    controller.abort(
      new DOMException("cancelled during identity load", "AbortError"),
    );
    release?.("55555555-5555-4555-8555-555555555555" as UUID);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(construct).not.toHaveBeenCalled();
  });

  it("rejects an existing hard-linked identity", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-hardlink-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    await fs.link(target, path.join(root, "second-link"));
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "must not have multiple links",
    );
  });

  it("rejects link injection after the identity descriptor opens", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-link-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    let injected = false;
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterIdentityOpen: async () => {
          if (injected) return;
          injected = true;
          await fs.link(target, path.join(root, "racing-link"));
        },
      })(root),
    ).rejects.toThrow("must not have multiple links");
  });

  it("rejects link injection between identity lstat and open", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-lstat-link-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    let injected = false;
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterIdentityLstat: async () => {
          if (injected) return;
          injected = true;
          await fs.link(target, path.join(root, "lstat-racing-link"));
        },
      })(root),
    ).rejects.toThrow("must not have multiple links");
  });

  it("rejects target replacement between lstat and open", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-open-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    let replaced = false;
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterIdentityLstat: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(target, path.join(root, "original-id"));
          await fs.writeFile(target, "66666666-6666-4666-8666-666666666666\n", {
            mode: 0o600,
          });
        },
      })(root),
    ).rejects.toThrow("changed during validation");
  });

  it("rejects target replacement after its descriptor opens", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-return-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const target = path.join(root, "runtime-installation-id");
    let replaced = false;
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterIdentityOpen: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(target, path.join(root, "opened-id"));
          await fs.writeFile(target, "77777777-7777-4777-8777-777777777777\n", {
            mode: 0o600,
          });
        },
      })(root),
    ).rejects.toThrow("changed during validation");
  });

  it("cleans both directory inodes after substitution following pre-create validation", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-dir-race-"),
    );
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    cleanup.push(parent);
    let replaced = false;
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterPreCreateValidation: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(root, moved);
          await fs.mkdir(root, { mode: 0o700 });
        },
      })(root),
    ).rejects.toThrow("state directory changed during validation");
    await expectNoIdentityArtifacts(root);
    await expectNoIdentityArtifacts(moved);
  });

  it("cleans both directory inodes after substitution following temporary creation", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-publish-race-"),
    );
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    cleanup.push(parent);
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterTemporaryCreate: async () => {
          await fs.rename(root, moved);
          await fs.mkdir(root, { mode: 0o700 });
        },
      })(root),
    ).rejects.toThrow("state directory changed during validation");
    await expectNoIdentityArtifacts(root);
    await expectNoIdentityArtifacts(moved);
  });

  it("cleans both directory inodes after substitution immediately after publication", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-linked-race-"),
    );
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    cleanup.push(parent);
    await expect(
      __createRuntimeInstallationIdLoaderForTests({
        afterIdentityPublication: async () => {
          await fs.rename(root, moved);
          await fs.mkdir(root, { mode: 0o700 });
        },
      })(root),
    ).rejects.toThrow("state directory changed during validation");
    await expectNoIdentityArtifacts(root);
    await expectNoIdentityArtifacts(moved);
  });

  it.runIf(process.platform === "win32")(
    "fails closed with a typed unsupported contract on real Windows",
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "runtime-owner-win-unsupported-"),
      );
      cleanup.push(root);
      await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toEqual(
        expect.objectContaining({
          code: "RUNTIME_INSTALLATION_ID_PLATFORM_UNSUPPORTED",
          name: RuntimeInstallationIdentityUnsupportedError.name,
        }),
      );
      await expectNoIdentityArtifacts(root);
    },
  );
});

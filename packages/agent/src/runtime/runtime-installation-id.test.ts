/** Exercises durable runtime installation identity against real temporary directories. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constructWithRuntimeInstallationIdentity,
  loadOrCreateRuntimeInstallationId,
} from "./runtime-installation-id.ts";

const cleanup: string[] = [];

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
      loadOrCreateRuntimeInstallationId(root, {
        afterIdentityOpen: async () => {
          if (injected) return;
          injected = true;
          await fs.link(target, path.join(root, "racing-link"));
        },
      }),
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
      loadOrCreateRuntimeInstallationId(root, {
        afterIdentityLstat: async () => {
          if (injected) return;
          injected = true;
          await fs.link(target, path.join(root, "lstat-racing-link"));
        },
      }),
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
      loadOrCreateRuntimeInstallationId(root, {
        afterIdentityLstat: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(target, path.join(root, "original-id"));
          await fs.writeFile(target, "66666666-6666-4666-8666-666666666666\n", {
            mode: 0o600,
          });
        },
      }),
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
      loadOrCreateRuntimeInstallationId(root, {
        afterIdentityOpen: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(target, path.join(root, "opened-id"));
          await fs.writeFile(target, "77777777-7777-4777-8777-777777777777\n", {
            mode: 0o600,
          });
        },
      }),
    ).rejects.toThrow("changed during validation");
  });

  it("rejects state-directory replacement before publication", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-dir-race-"),
    );
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    cleanup.push(parent);
    let replaced = false;
    await expect(
      loadOrCreateRuntimeInstallationId(root, {
        afterDirectoryValidation: async () => {
          if (replaced) return;
          replaced = true;
          await fs.rename(root, moved);
          await fs.mkdir(root, { mode: 0o700 });
        },
      }),
    ).rejects.toThrow("state directory changed during validation");
    await expect(
      fs.access(path.join(root, "runtime-installation-id")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(moved, "runtime-installation-id")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects state-directory replacement at the publication boundary", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-publish-race-"),
    );
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    cleanup.push(parent);
    await expect(
      loadOrCreateRuntimeInstallationId(root, {
        beforeIdentityPublication: async () => {
          await fs.rename(root, moved);
          await fs.mkdir(root, { mode: 0o700 });
        },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(root, "runtime-installation-id")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(moved, "runtime-installation-id")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EINVAL", "EPERM"])(
    "degrades only unsupported Windows directory-open %s",
    async (code) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "runtime-owner-win-open-"),
      );
      cleanup.push(root);
      await expect(
        loadOrCreateRuntimeInstallationId(root, {
          platform: "win32",
          openDirectory: async () => {
            throw Object.assign(new Error("unsupported directory open"), {
              code,
            });
          },
        }),
      ).resolves.toMatch(/^[a-f0-9-]{36}$/);
    },
  );

  it.each(["EINVAL", "EPERM"])(
    "degrades only unsupported Windows directory-sync %s",
    async (code) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "runtime-owner-win-sync-"),
      );
      cleanup.push(root);
      await expect(
        loadOrCreateRuntimeInstallationId(root, {
          platform: "win32",
          syncDirectory: async () => {
            throw Object.assign(new Error("unsupported directory sync"), {
              code,
            });
          },
        }),
      ).resolves.toMatch(/^[a-f0-9-]{36}$/);
    },
  );

  it.each(["open", "sync"] as const)(
    "propagates real Windows directory %s failures",
    async (operation) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "runtime-owner-win-io-"),
      );
      cleanup.push(root);
      const failure = Object.assign(new Error("real directory I/O failure"), {
        code: "EIO",
      });
      await expect(
        loadOrCreateRuntimeInstallationId(root, {
          platform: "win32",
          ...(operation === "open"
            ? { openDirectory: async () => await Promise.reject(failure) }
            : { syncDirectory: async () => await Promise.reject(failure) }),
        }),
      ).rejects.toBe(failure);
    },
  );

  it("supports existing/new Windows identities while rejecting corrupt and symlink paths", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-win-valid-"),
    );
    const corrupt = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-win-bad-"),
    );
    const linked = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-win-link-"),
    );
    cleanup.push(root, corrupt, linked);
    const created = await loadOrCreateRuntimeInstallationId(root, {
      platform: "win32",
    });
    const target = path.join(root, "runtime-installation-id");
    await fs.chmod(target, 0o644);
    await expect(
      loadOrCreateRuntimeInstallationId(root, { platform: "win32" }),
    ).resolves.toBe(created);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    await fs.writeFile(path.join(corrupt, "runtime-installation-id"), "bad\n");
    await fs.writeFile(path.join(linked, "external"), `${created}\n`);
    await fs.symlink(
      path.join(linked, "external"),
      path.join(linked, "runtime-installation-id"),
    );
    await expect(
      loadOrCreateRuntimeInstallationId(corrupt, { platform: "win32" }),
    ).rejects.toThrow("corrupt");
    await expect(
      loadOrCreateRuntimeInstallationId(linked, { platform: "win32" }),
    ).rejects.toThrow("regular file");
  });
});

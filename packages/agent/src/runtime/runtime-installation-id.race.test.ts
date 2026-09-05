/** Exercises runtime identity races by faulting real filesystem calls outside production. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const faults = vi.hoisted(() => ({
  beforeOpen: undefined as ((target: string) => Promise<void>) | undefined,
  afterLstat: undefined as
    | ((
        target: string,
        stat: Awaited<ReturnType<typeof fs.lstat>>,
      ) => Promise<void>)
    | undefined,
  afterOpen: undefined as
    | ((target: string, handle: FileHandle) => Promise<void>)
    | undefined,
  afterLink: undefined as
    | ((source: string, target: string) => Promise<void>)
    | undefined,
  afterUnlink: undefined as ((target: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      await faults.afterLstat?.(String(args[0]), stat);
      return stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      await faults.beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      await faults.afterOpen?.(String(args[0]), handle);
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      await faults.afterLink?.(String(args[0]), String(args[1]));
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await actual.unlink(...args);
      await faults.afterUnlink?.(String(args[0]));
    },
  };
});

const {
  loadOrCreateRuntimeInstallationId,
  RuntimeInstallationIdentityRecoveryError,
} = await import("./runtime-installation-id.ts");
const cleanup: string[] = [];

async function expectNoIdentityArtifacts(directory: string): Promise<void> {
  expect(
    (await fs.readdir(directory)).filter(
      (name) =>
        name === "runtime-installation-id" ||
        name.startsWith(".runtime-installation-id."),
    ),
  ).toEqual([]);
}

afterEach(async () => {
  faults.beforeOpen = undefined;
  faults.afterLstat = undefined;
  faults.afterOpen = undefined;
  faults.afterLink = undefined;
  faults.afterUnlink = undefined;
  await Promise.all(
    cleanup
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runtime installation identity filesystem races", () => {
  it.each(["directory", "platform-alias", "mixed-alias"])(
    "does not open SELinux-protected ancestors above an Android %s boundary",
    async (layout) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-android-open-")),
      );
      cleanup.push(root);
      const physicalUser = path.join(root, "data", "data");
      const lexicalUser =
        layout !== "directory"
          ? path.join(root, "data", "user", "0")
          : physicalUser;
      const appDataDirectory = path.join(lexicalUser, "ai.elizaos.app");
      const physicalAppData = path.join(physicalUser, "ai.elizaos.app");
      const stateDirectory = path.join(
        layout === "mixed-alias" ? physicalAppData : appDataDirectory,
        "files",
        "agent-state",
      );
      await fs.mkdir(path.join(physicalAppData, "files"), {
        recursive: true,
        mode: 0o700,
      });
      if (layout !== "directory") {
        await fs.mkdir(path.dirname(lexicalUser), {
          recursive: true,
          mode: 0o700,
        });
        await fs.symlink(physicalUser, lexicalUser, "dir");
      }
      const previousPlatform = process.env.ELIZA_PLATFORM;
      const previousBoundary = process.env.ELIZA_ANDROID_APP_DATA_DIR;
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_ANDROID_APP_DATA_DIR = appDataDirectory;
      faults.beforeOpen = async (target) => {
        const inside = [appDataDirectory, physicalAppData].some((boundary) => {
          const relative = path.relative(boundary, path.resolve(target));
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative))
          );
        });
        if (!inside) {
          throw Object.assign(new Error(`SELinux denied open: ${target}`), {
            code: "EACCES",
          });
        }
      };
      try {
        await expect(
          loadOrCreateRuntimeInstallationId(stateDirectory),
        ).resolves.toMatch(/^[a-f0-9-]{36}$/);
      } finally {
        if (previousPlatform === undefined) delete process.env.ELIZA_PLATFORM;
        else process.env.ELIZA_PLATFORM = previousPlatform;
        if (previousBoundary === undefined)
          delete process.env.ELIZA_ANDROID_APP_DATA_DIR;
        else process.env.ELIZA_ANDROID_APP_DATA_DIR = previousBoundary;
      }
    },
  );

  it.each(["aliased", "physical"])(
    "rejects replacement of a captured Android platform alias with a %s state path",
    async (statePath) => {
      const root = await fs.realpath(
        await fs.mkdtemp(
          path.join(os.tmpdir(), "runtime-id-android-retarget-"),
        ),
      );
      cleanup.push(root);
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      const alias = path.join(root, "user-zero");
      for (const target of [first, second]) {
        await fs.mkdir(path.join(target, "app", "files"), {
          recursive: true,
          mode: 0o700,
        });
      }
      await fs.symlink(first, alias, "dir");
      const previousPlatform = process.env.ELIZA_PLATFORM;
      const previousBoundary = process.env.ELIZA_ANDROID_APP_DATA_DIR;
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_ANDROID_APP_DATA_DIR = path.join(alias, "app");
      let replaced = false;
      faults.afterLstat = async (target) => {
        if (target === alias && !replaced) {
          replaced = true;
          await fs.rename(alias, path.join(root, "captured-alias"));
          await fs.symlink(second, alias, "dir");
        }
      };
      try {
        await expect(
          loadOrCreateRuntimeInstallationId(
            path.join(
              statePath === "physical" ? first : alias,
              "app",
              "files",
              "state",
            ),
          ),
        ).rejects.toThrow(
          "Runtime state lexical path changed during validation",
        );
        for (const target of [first, second]) {
          await expect(
            fs.access(path.join(target, "app", "files", "state")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        if (previousPlatform === undefined) delete process.env.ELIZA_PLATFORM;
        else process.env.ELIZA_PLATFORM = previousPlatform;
        if (previousBoundary === undefined)
          delete process.env.ELIZA_ANDROID_APP_DATA_DIR;
        else process.env.ELIZA_ANDROID_APP_DATA_DIR = previousBoundary;
      }
    },
  );

  it("rejects link injection between identity lstat and open", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-lstat-link-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const canonicalRoot = await fs.realpath(root);
    const target = path.join(canonicalRoot, "runtime-installation-id");
    faults.afterLstat = async (observed) => {
      if (observed !== target) return;
      faults.afterLstat = undefined;
      await fs.link(target, path.join(root, "racing-link"));
    };
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "must not have multiple links",
    );
  });

  it("rejects link injection after the identity descriptor opens", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-open-link-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const canonicalRoot = await fs.realpath(root);
    const target = path.join(canonicalRoot, "runtime-installation-id");
    faults.afterOpen = async (observed) => {
      if (observed !== target) return;
      faults.afterOpen = undefined;
      await fs.link(target, path.join(root, "racing-link"));
    };
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "must not have multiple links",
    );
  });

  it("rejects target replacement between lstat and open", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-open-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const canonicalRoot = await fs.realpath(root);
    const target = path.join(canonicalRoot, "runtime-installation-id");
    faults.afterLstat = async (observed) => {
      if (observed !== target) return;
      faults.afterLstat = undefined;
      await fs.rename(target, path.join(root, "original-id"));
      await fs.writeFile(target, "66666666-6666-4666-8666-666666666666\n", {
        mode: 0o600,
      });
    };
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "changed during validation",
    );
  });

  it("rejects target replacement after its descriptor opens", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-return-race-"),
    );
    cleanup.push(root);
    await loadOrCreateRuntimeInstallationId(root);
    const canonicalRoot = await fs.realpath(root);
    const target = path.join(canonicalRoot, "runtime-installation-id");
    faults.afterOpen = async (observed) => {
      if (observed !== target) return;
      faults.afterOpen = undefined;
      await fs.rename(target, path.join(canonicalRoot, "opened-id"));
      await fs.writeFile(target, "77777777-7777-4777-8777-777777777777\n", {
        mode: 0o600,
      });
    };
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "changed during validation",
    );
  });

  it("cleans both directory inodes after each publication substitution phase", async () => {
    for (const phase of ["pre-create", "temporary", "published"] as const) {
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), `runtime-id-${phase}-`),
      );
      cleanup.push(parent);
      const root = path.join(parent, "state");
      const moved = path.join(parent, "moved-state");
      const canonicalParent = await fs.realpath(parent);
      const canonicalRoot = path.join(canonicalParent, "state");
      const canonicalMoved = path.join(canonicalParent, "moved-state");
      let stateLstats = 0;
      const substitute = async () => {
        await fs.rename(canonicalRoot, canonicalMoved);
        await fs.mkdir(canonicalRoot, { mode: 0o700 });
      };
      if (phase === "pre-create") {
        faults.afterLstat = async (observed) => {
          if (observed !== canonicalRoot || ++stateLstats !== 3) return;
          faults.afterLstat = undefined;
          await substitute();
        };
      } else if (phase === "temporary") {
        faults.afterLstat = async (observed) => {
          if (!path.basename(observed).startsWith(".runtime-installation-id."))
            return;
          faults.afterLstat = undefined;
          await substitute();
        };
      } else {
        faults.afterLink = async () => {
          faults.afterLink = undefined;
          await substitute();
        };
      }
      await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
        "state directory changed during validation",
      );
      await expectNoIdentityArtifacts(root);
      await expectNoIdentityArtifacts(moved);
    }
  });

  it("closes and durably cleans a candidate whose descriptor stat fails", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-stat-fail-"),
    );
    cleanup.push(parent);
    const root = path.join(parent, "state");
    let closeCount = 0;
    const durabilityEvents: string[] = [];
    faults.afterOpen = async (observed, handle) => {
      const canonicalRoot = path.join(await fs.realpath(parent), "state");
      if (observed === canonicalRoot) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          durabilityEvents.push("sync");
          await sync();
        };
        return;
      }
      if (!path.basename(observed).startsWith(".runtime-installation-id."))
        return;
      faults.afterOpen = undefined;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closeCount += 1;
        await close();
      };
      handle.stat = async () => {
        throw new Error("injected candidate stat failure");
      };
    };
    faults.afterUnlink = async (observed) => {
      if (!path.basename(observed).startsWith(".runtime-installation-id."))
        return;
      durabilityEvents.push("unlink");
    };
    await expect(loadOrCreateRuntimeInstallationId(root)).rejects.toThrow(
      "injected candidate stat failure",
    );
    expect(closeCount).toBeGreaterThan(0);
    expect(durabilityEvents).toEqual(["unlink", "sync"]);
    await expectNoIdentityArtifacts(root);
  });

  it("reports ambiguous recovery only after post-link cleanup attempts directory sync", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-sync-fail-"),
    );
    cleanup.push(parent);
    const root = path.join(parent, "state");
    const moved = path.join(parent, "moved-state");
    const canonicalParent = await fs.realpath(parent);
    const canonicalRoot = path.join(canonicalParent, "state");
    const events: string[] = [];
    faults.afterOpen = async (observed, handle) => {
      if (observed !== canonicalRoot) return;
      faults.afterOpen = undefined;
      handle.sync = async () => {
        events.push("sync");
        throw new Error("injected directory sync failure");
      };
    };
    faults.afterLink = async () => {
      faults.afterLink = undefined;
      await fs.rename(canonicalRoot, path.join(canonicalParent, "moved-state"));
      await fs.mkdir(canonicalRoot, { mode: 0o700 });
      events.push("substituted");
    };
    await expect(
      loadOrCreateRuntimeInstallationId(root),
    ).rejects.toBeInstanceOf(RuntimeInstallationIdentityRecoveryError);
    expect(events).toEqual(["substituted", "sync"]);
    await expectNoIdentityArtifacts(root);
    await expectNoIdentityArtifacts(moved);
  });

  it("preserves typed recovery when cleanup sync and state close both fail", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-sync-close-fail-"),
    );
    cleanup.push(parent);
    const root = path.join(parent, "state");
    const canonicalParent = await fs.realpath(parent);
    const canonicalRoot = path.join(canonicalParent, "state");
    faults.afterOpen = async (observed, handle) => {
      if (observed !== canonicalRoot) return;
      faults.afterOpen = undefined;
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        throw new Error("injected cleanup sync failure");
      };
      handle.close = async () => {
        await close();
        throw new Error("injected state close failure");
      };
    };
    faults.afterLink = async () => {
      faults.afterLink = undefined;
      await fs.rename(canonicalRoot, path.join(canonicalParent, "moved-state"));
      await fs.mkdir(canonicalRoot, { mode: 0o700 });
    };
    const failure = await loadOrCreateRuntimeInstallationId(root).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeInstallationIdentityRecoveryError);
    expect(failure).toMatchObject({
      code: "RUNTIME_INSTALLATION_ID_RECOVERY_AMBIGUOUS",
      cause: expect.any(AggregateError),
    });
  });
});

/** Exercises durable runtime installation identity against real temporary directories. */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  constructWithRuntimeInstallationIdentity,
  loadOrCreateRuntimeInstallationId,
  RuntimeInstallationIdentityUnsupportedError,
} from "./runtime-installation-id.ts";

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);
const originalElizaPlatform = process.env.ELIZA_PLATFORM;
const originalAndroidAppDataDir = process.env.ELIZA_ANDROID_APP_DATA_DIR;
const originalIosAppDataDir = process.env.ELIZA_IOS_APP_DATA_DIR;

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
  vi.restoreAllMocks();
  if (originalElizaPlatform === undefined) {
    delete process.env.ELIZA_PLATFORM;
  } else {
    process.env.ELIZA_PLATFORM = originalElizaPlatform;
  }
  if (originalAndroidAppDataDir === undefined) {
    delete process.env.ELIZA_ANDROID_APP_DATA_DIR;
  } else {
    process.env.ELIZA_ANDROID_APP_DATA_DIR = originalAndroidAppDataDir;
  }
  if (originalIosAppDataDir === undefined)
    delete process.env.ELIZA_IOS_APP_DATA_DIR;
  else process.env.ELIZA_IOS_APP_DATA_DIR = originalIosAppDataDir;
  await Promise.all(
    cleanup
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runtime installation identity", () => {
  it("keeps one iOS identity beneath a platform-managed simulator ancestor", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-ios-")),
    );
    cleanup.push(root);
    const platformDirectory = path.join(root, "simulator-data");
    const state = path.join(
      platformDirectory,
      "container",
      "Library",
      "Application Support",
      "Eliza",
    );
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.chmod(platformDirectory, 0o775);
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_IOS_APP_DATA_DIR = path.dirname(state);
    const values = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateRuntimeInstallationId(state)),
    );
    expect(new Set(values).size).toBe(1);
    expect(await loadOrCreateRuntimeInstallationId(state)).toBe(values[0]);
    expect(
      await fs.readFile(path.join(state, "runtime-installation-id"), "utf8"),
    ).toBe(`${values[0]}\n`);
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(root, "outside")),
    ).rejects.toThrow("must remain inside");
    process.env.ELIZA_PLATFORM = "desktop";
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      "replaceable by another user",
    );
  });

  it("rejects missing, relative, escaped, linked and writable iOS boundaries", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-ios-invalid-")),
    );
    cleanup.push(root);
    const boundary = path.join(root, "app-data");
    const state = path.join(boundary, "app-support");
    const outside = path.join(root, "outside");
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await fs.mkdir(outside, { mode: 0o700 });
    process.env.ELIZA_PLATFORM = "ios";
    delete process.env.ELIZA_IOS_APP_DATA_DIR;
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      "requires an absolute ELIZA_IOS_APP_DATA_DIR",
    );
    process.env.ELIZA_IOS_APP_DATA_DIR = "relative";
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      "requires an absolute ELIZA_IOS_APP_DATA_DIR",
    );
    process.env.ELIZA_IOS_APP_DATA_DIR = outside;
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      "must remain inside ELIZA_IOS_APP_DATA_DIR",
    );
    const linked = path.join(root, "linked-support");
    await fs.symlink(boundary, linked, "dir");
    process.env.ELIZA_IOS_APP_DATA_DIR = linked;
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(linked, "app-support")),
    ).rejects.toThrow(/real directory/);
    process.env.ELIZA_IOS_APP_DATA_DIR = boundary;
    await fs.symlink(outside, path.join(state, "redirect"), "dir");
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(state, "redirect", "nested")),
    ).rejects.toThrow(/real directory/);
    await fs.chmod(state, 0o777);
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      /writable by another user/,
    );
    await fs.chmod(state, 0o700);
    await fs.chmod(boundary, 0o777);
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      /replaceable by another user/,
    );
    await fs.chmod(boundary, 0o700);
    await expectNoIdentityArtifacts(state);
    await expectNoIdentityArtifacts(outside);
  });

  it("preserves identity through an Android platform-owned app-data alias", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-android-alias-")),
    );
    cleanup.push(root);
    const physicalData = path.join(root, "data", "data");
    const users = path.join(root, "data", "user");
    const appDataDirectory = path.join(users, "0", "ai.elizaos.app");
    const stateDirectory = path.join(appDataDirectory, "files", "agent-state");
    await fs.mkdir(path.join(physicalData, "ai.elizaos.app", "files"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(users, { recursive: true, mode: 0o700 });
    await fs.symlink(physicalData, path.join(users, "0"), "dir");
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_ANDROID_APP_DATA_DIR = appDataDirectory;
    const id = await loadOrCreateRuntimeInstallationId(stateDirectory);
    expect(await loadOrCreateRuntimeInstallationId(stateDirectory)).toBe(id);
    expect(
      await fs.readFile(
        path.join(
          physicalData,
          "ai.elizaos.app",
          "files",
          "agent-state",
          "runtime-installation-id",
        ),
        "utf8",
      ),
    ).toBe(`${id}\n`);
  });

  it("rejects an aliased app boundary and a state redirect outside that boundary", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runtime-id-android-escape-")),
    );
    cleanup.push(root);
    const physicalAppData = path.join(root, "app-data");
    const aliasAppData = path.join(root, "alias-app-data");
    const outside = path.join(root, "outside");
    await fs.mkdir(physicalAppData, { mode: 0o700 });
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(physicalAppData, aliasAppData, "dir");
    await fs.mkdir(path.join(physicalAppData, "files"), { mode: 0o700 });
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_ANDROID_APP_DATA_DIR = aliasAppData;
    await expect(
      loadOrCreateRuntimeInstallationId(
        path.join(aliasAppData, "files", "agent-state"),
      ),
    ).rejects.toThrow("Runtime state parent must be a real directory");
    process.env.ELIZA_ANDROID_APP_DATA_DIR = physicalAppData;
    await fs.symlink(outside, path.join(physicalAppData, "redirect"), "dir");
    await expect(
      loadOrCreateRuntimeInstallationId(
        path.join(physicalAppData, "redirect", "agent-state"),
      ),
    ).rejects.toThrow("Runtime state parent must be a real directory");
    await fs.mkdir(path.join(outside, "nested"), { mode: 0o700 });
    await expect(
      loadOrCreateRuntimeInstallationId(
        path.join(physicalAppData, "redirect", "nested", "agent-state"),
      ),
    ).rejects.toThrow("Resolved Android runtime state directory escaped");
    await expect(
      fs.access(path.join(outside, "nested", "agent-state")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(physicalAppData, "files", "agent-state")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the explicit Android app-data boundary for platform ancestors", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-android-"),
    );
    const appDataDirectory = path.join(
      root,
      "data",
      "user",
      "0",
      "ai.elizaos.app",
    );
    const stateDirectory = path.join(appDataDirectory, "files", "agent-state");
    cleanup.push(root);
    await fs.mkdir(path.dirname(stateDirectory), {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(appDataDirectory, 0o700);
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_ANDROID_APP_DATA_DIR = appDataDirectory;

    await expect(
      loadOrCreateRuntimeInstallationId(stateDirectory),
    ).resolves.toMatch(/^[a-f0-9-]{36}$/);
  });

  it("rejects missing, escaped, and mutable Android app-data boundaries", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-android-boundary-"),
    );
    const appDataDirectory = path.join(root, "app-data");
    const stateDirectory = path.join(appDataDirectory, "files", "agent-state");
    const escapedState = path.join(root, "escaped", "agent-state");
    cleanup.push(root);
    await fs.mkdir(path.dirname(stateDirectory), {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(path.dirname(escapedState), {
      recursive: true,
      mode: 0o700,
    });
    process.env.ELIZA_PLATFORM = "android";

    delete process.env.ELIZA_ANDROID_APP_DATA_DIR;
    await expect(
      loadOrCreateRuntimeInstallationId(stateDirectory),
    ).rejects.toThrow("requires an absolute ELIZA_ANDROID_APP_DATA_DIR");

    process.env.ELIZA_ANDROID_APP_DATA_DIR = appDataDirectory;
    await expect(
      loadOrCreateRuntimeInstallationId(escapedState),
    ).rejects.toThrow("must remain inside ELIZA_ANDROID_APP_DATA_DIR");

    await fs.chmod(appDataDirectory, 0o777);
    await expect(
      loadOrCreateRuntimeInstallationId(stateDirectory),
    ).rejects.toThrow("replaceable by another user");
    await expect(fs.access(stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

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

  it("rejects an attacker-writable grandparent before creating state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-grandparent-"),
    );
    const hostileGrandparent = path.join(root, "hostile");
    const safeParent = path.join(hostileGrandparent, "safe");
    const state = path.join(safeParent, "state");
    cleanup.push(root);
    await fs.mkdir(safeParent, { recursive: true, mode: 0o700 });
    await fs.chmod(hostileGrandparent, 0o777);
    await expect(loadOrCreateRuntimeInstallationId(state)).rejects.toThrow(
      "replaceable by another user",
    );
    await expect(fs.access(state)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoIdentityArtifacts(safeParent);
  });

  it("rejects an attacker-writable lexical ancestor before following its redirect", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-lexical-"),
    );
    const hostile = path.join(root, "hostile");
    const safe = path.join(root, "safe");
    const safeParent = path.join(safe, "parent");
    const redirect = path.join(hostile, "redirect");
    const requestedState = path.join(redirect, "parent", "state");
    const resolvedState = path.join(safeParent, "state");
    cleanup.push(root);
    await fs.mkdir(hostile, { mode: 0o700 });
    await fs.chmod(hostile, 0o777);
    await fs.mkdir(safeParent, { recursive: true, mode: 0o700 });
    await fs.symlink(safe, redirect);
    await expect(
      loadOrCreateRuntimeInstallationId(requestedState),
    ).rejects.toThrow("replaceable by another user");
    await expect(fs.access(requestedState)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(resolvedState)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectNoIdentityArtifacts(safeParent);
  });

  it("accepts an intermediate redirect controlled by a trusted ancestor", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-owner-safe-redirect-"),
    );
    const controlled = path.join(root, "controlled");
    const destination = path.join(root, "destination");
    const destinationParent = path.join(destination, "parent");
    const redirect = path.join(controlled, "redirect");
    cleanup.push(root);
    await fs.mkdir(controlled, { mode: 0o700 });
    await fs.mkdir(destinationParent, { recursive: true, mode: 0o700 });
    await fs.symlink(destination, redirect);
    await expect(
      loadOrCreateRuntimeInstallationId(path.join(redirect, "parent", "state")),
    ).resolves.toMatch(/^[a-f0-9-]{36}$/);
  });

  it("does not expose test controls to a real Bun sibling consumer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "runtime-id-consumer-"),
    );
    const nodeModules = path.join(root, "node_modules", "@elizaos");
    cleanup.push(root);
    await fs.mkdir(nodeModules, { recursive: true });
    await fs.symlink(
      path.resolve(import.meta.dirname, "../.."),
      path.join(nodeModules, "agent"),
      "dir",
    );
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "identity-sibling-consumer", type: "module" }),
    );
    // The fixture must be able to resolve the package at all, or "the deep
    // subpath threw" proves nothing: every resolution failure would look like
    // an enforced boundary. Import the public `./runtime` subpath first and
    // require it to succeed, then require the blocked one to fail. Asserting
    // the OUTCOME rather than an error message keeps this off Bun's
    // resolver wording, which differs between releases.
    const script = [
      'const control = await import("@elizaos/agent/runtime");',
      'if (Object.keys(control).length === 0) { console.error("control subpath resolved but exported nothing"); process.exit(8); }',
      "let blocked = false;",
      "try {",
      '  await import("@elizaos/agent/runtime/runtime-installation-id");',
      "} catch {",
      "  blocked = true;",
      "}",
      'if (!blocked) { console.error("blocked subpath was importable by a sibling consumer"); process.exit(7); }',
    ].join("\n");
    await expect(
      execFileAsync("bun", ["--eval", script], { cwd: root }),
    ).resolves.toMatchObject({ stderr: "" });
  });

  /**
   * The consumer probe above can only prove the subpath stays unreachable. It
   * cannot inspect a module it is forbidden to load, so the "no test controls
   * escape" half is asserted here against the real module surface — by NAME
   * SHAPE, not one hardcoded identifier. The previous probe looked for
   * `__createRuntimeInstallationIdLoaderForTests`, which never existed in any
   * implementation, so its leak branch was unreachable from the day it landed.
   */
  it("exports no test-only controls from the identity module", async () => {
    const surface = await import("./runtime-installation-id.ts");
    const testOnly = Object.keys(surface).filter(
      (name) =>
        name.startsWith("__") ||
        /ForTests?$/.test(name) ||
        name.toLowerCase().includes("fortest"),
    );

    expect(testOnly).toEqual([]);
    // Guard the guard: the surface must be non-empty, or the filter above
    // would pass on an empty module.
    expect(Object.keys(surface).length).toBeGreaterThan(0);
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

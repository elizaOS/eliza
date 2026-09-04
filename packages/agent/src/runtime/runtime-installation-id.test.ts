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

/**
 * Behavioral coverage for hook discovery: source precedence, handler lookup,
 * frontmatter parsing, and skip paths for missing/invalid entries.
 *
 * Drives the real `discoverHooks` export against a temp filesystem. Managed
 * hooks are isolated with ELIZA_STATE_DIR so the suite never scans the
 * operator's live state directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverHooks } from "./discovery.ts";

interface WriteHookOptions {
  dirName?: string;
  description?: string;
  homepage?: string;
  metadataLine?: string;
  extraFrontmatter?: string;
  handlerName?: string;
  skipHandler?: boolean;
  skipFrontmatter?: boolean;
  rawFrontmatter?: string;
}

function writeHook(
  parentDir: string,
  name: string,
  options: WriteHookOptions = {},
) {
  const hookDir = join(parentDir, options.dirName ?? name);
  mkdirSync(hookDir, { recursive: true });

  if (options.skipFrontmatter) {
    writeFileSync(join(hookDir, "HOOK.md"), "no frontmatter here\n");
  } else {
    const frontmatter =
      options.rawFrontmatter ??
      [
        "---",
        `name: ${name}`,
        `description: ${options.description ?? `${name} description`}`,
        options.homepage ? `homepage: ${options.homepage}` : null,
        options.metadataLine,
        options.extraFrontmatter,
        "---",
        "",
        `# ${name}`,
      ]
        .filter((line) => line !== null && line !== undefined)
        .join("\n");
    writeFileSync(join(hookDir, "HOOK.md"), frontmatter);
  }

  if (!options.skipHandler) {
    writeFileSync(
      join(hookDir, options.handlerName ?? "handler.ts"),
      "export default function handler() {}\n",
    );
  }

  return hookDir;
}

describe("discoverHooks", () => {
  let root: string;
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "eliza-hook-discovery-"));
    stateDir = join(root, "state");
    mkdirSync(join(stateDir, "hooks"), { recursive: true });
    previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty list when no hook directories contain entries", async () => {
    const hooks = await discoverHooks({
      bundledDir: join(root, "missing-bundled"),
      workspacePath: join(root, "empty-workspace"),
      extraDirs: [join(root, "missing-extra")],
    });
    expect(hooks).toEqual([]);
  });

  it("discovers a single valid hook from the bundled directory", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "solo", { description: "only hook" });

    const hooks = await discoverHooks({ bundledDir });

    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.hook.name).toBe("solo");
    expect(hooks[0]?.hook.description).toBe("only hook");
    expect(hooks[0]?.hook.source).toBe("eliza-bundled");
    expect(hooks[0]?.hook.pluginId).toBeUndefined();
    expect(hooks[0]?.hook.filePath).toBe(join(bundledDir, "solo", "HOOK.md"));
    expect(hooks[0]?.hook.baseDir).toBe(join(bundledDir, "solo"));
    expect(hooks[0]?.hook.handlerPath).toBe(
      join(bundledDir, "solo", "handler.ts"),
    );
    expect(hooks[0]?.frontmatter.name).toBe("solo");
    expect(hooks[0]?.metadata).toBeUndefined();
  });

  it("skips a missing extra dir, a non-directory extra path, and loose files in a scan root", async () => {
    const extraDir = join(root, "extra");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "not-a-hook.txt"), "ignored");
    writeHook(extraDir, "kept");
    writeFileSync(join(root, "not-a-dir"), "file");

    const hooks = await discoverHooks({
      extraDirs: [
        join(root, "does-not-exist"),
        join(root, "not-a-dir"),
        extraDir,
      ],
    });

    expect(hooks.map((entry) => entry.hook.name)).toEqual(["kept"]);
    expect(hooks[0]?.hook.source).toBe("eliza-managed");
  });

  it("skips directories that lack HOOK.md, lack a handler, or have invalid frontmatter", async () => {
    const bundledDir = join(root, "bundled");
    mkdirSync(join(bundledDir, "no-md"), { recursive: true });
    writeFileSync(
      join(bundledDir, "no-md", "handler.ts"),
      "export default {}\n",
    );

    writeHook(bundledDir, "no-handler", { skipHandler: true });
    writeHook(bundledDir, "no-frontmatter", { skipFrontmatter: true });
    writeHook(bundledDir, "unnamed", {
      rawFrontmatter: ["---", "description: missing name", "---", ""].join(
        "\n",
      ),
    });
    writeHook(bundledDir, "valid");

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks.map((entry) => entry.hook.name)).toEqual(["valid"]);
  });

  it("selects the first matching handler name and ignores later aliases", async () => {
    const bundledDir = join(root, "bundled");
    const hookDir = writeHook(bundledDir, "multi-handler", {
      handlerName: "handler.ts",
    });
    writeFileSync(
      join(hookDir, "index.ts"),
      "export default function index() {}\n",
    );

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.hook.handlerPath).toBe(join(hookDir, "handler.ts"));
  });

  it("accepts each documented handler filename when it is the only candidate", async () => {
    const bundledDir = join(root, "bundled");
    const names = [
      "handler.ts",
      "handler.mjs",
      "handler",
      "index.ts",
      "index.mjs",
      "index",
    ] as const;

    for (const handlerName of names) {
      writeHook(bundledDir, handlerName.replace(".", "-"), { handlerName });
    }

    const hooks = await discoverHooks({ bundledDir });
    const byName = new Map(
      hooks.map((entry) => [entry.hook.name, entry.hook.handlerPath]),
    );

    expect(byName.size).toBe(names.length);
    for (const handlerName of names) {
      const hookName = handlerName.replace(".", "-");
      expect(byName.get(hookName)).toBe(
        join(bundledDir, hookName, handlerName),
      );
    }
  });

  it("strips quoted frontmatter values and skips non key-value lines", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "quoted", {
      rawFrontmatter: [
        "---",
        'name: "quoted-hook"',
        "description: 'quoted description'",
        "# comment",
        "homepage: https://example.test/hooks/quoted",
        "---",
        "",
      ].join("\n"),
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.hook.name).toBe("quoted-hook");
    expect(hooks[0]?.hook.description).toBe("quoted description");
    expect(hooks[0]?.frontmatter.homepage).toBe(
      "https://example.test/hooks/quoted",
    );
  });

  it("parses inline JSON metadata and copies eliza fields onto the entry", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "meta-inline", {
      homepage: "https://frontmatter.example/hook",
      metadataLine: `metadata: {"eliza":{"always":true,"hookKey":"meta-key","emoji":"🔥","events":["session:start"],"export":"run","os":["darwin"],"requires":{"bins":["git"]},"install":[{"id":"git","kind":"bundled"}]}}`,
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.metadata).toEqual({
      always: true,
      hookKey: "meta-key",
      emoji: "🔥",
      homepage: "https://frontmatter.example/hook",
      events: ["session:start"],
      export: "run",
      os: ["darwin"],
      requires: { bins: ["git"] },
      install: [{ id: "git", kind: "bundled" }],
    });
  });

  it("parses a metadata JSON object that follows a metadata key with a same-line value", async () => {
    const bundledDir = join(root, "bundled");
    // The line matcher requires `key: value`. A bare `metadata:` line is
    // skipped, so the spanning JSON is only read when that key has a value.
    writeHook(bundledDir, "meta-block", {
      extraFrontmatter: [
        "metadata: ignored",
        '{"eliza":{"events":["agent:start"],"homepage":"https://meta.example"}}',
      ].join("\n"),
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks[0]?.metadata?.events).toEqual(["agent:start"]);
    expect(hooks[0]?.metadata?.homepage).toBe("https://meta.example");
  });

  it("does not treat a bare metadata: line as metadata", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "meta-bare", {
      extraFrontmatter: [
        "metadata:",
        '{"eliza":{"events":["agent:start"]}}',
      ].join("\n"),
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.metadata).toBeUndefined();
  });

  it("treats a non-array events field as an empty list and keeps the hook", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "bad-events", {
      metadataLine: `metadata: {"eliza":{"events":"session:start"}}`,
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.metadata?.events).toEqual([]);
  });

  it("keeps a hook whose metadata JSON is unparseable", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "broken-meta", {
      metadataLine: "metadata: {not-json",
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks.map((entry) => entry.hook.name)).toEqual(["broken-meta"]);
    expect(hooks[0]?.metadata).toBeUndefined();
  });

  it("ignores metadata that has no eliza object", async () => {
    const bundledDir = join(root, "bundled");
    writeHook(bundledDir, "no-eliza", {
      metadataLine: `metadata: {"other":{"events":["x"]}}`,
    });

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks[0]?.frontmatter.metadata).toEqual({
      other: { events: ["x"] },
    });
    expect(hooks[0]?.metadata).toBeUndefined();
  });

  it("lets later extraDirs win a same-name tie, then bundled, managed, and workspace in that order", async () => {
    const extraLow = join(root, "extra-low");
    const extraHigh = join(root, "extra-high");
    const bundledDir = join(root, "bundled");
    const workspacePath = join(root, "workspace");
    const managedDir = join(stateDir, "hooks");
    const extraDirs = [extraLow, extraHigh];

    writeHook(extraLow, "shared", { description: "extra-low" });
    writeHook(extraHigh, "shared", { description: "extra-high" });

    const afterExtraOnly = await discoverHooks({ extraDirs });
    expect(afterExtraOnly).toHaveLength(1);
    expect(afterExtraOnly[0]?.hook.description).toBe("extra-high");
    expect(afterExtraOnly[0]?.hook.source).toBe("eliza-managed");

    writeHook(bundledDir, "shared", { description: "bundled" });
    const afterBundled = await discoverHooks({ extraDirs, bundledDir });
    expect(afterBundled[0]?.hook.description).toBe("bundled");
    expect(afterBundled[0]?.hook.source).toBe("eliza-bundled");

    writeHook(managedDir, "shared", { description: "managed" });
    const afterManaged = await discoverHooks({ extraDirs, bundledDir });
    expect(afterManaged[0]?.hook.description).toBe("managed");
    expect(afterManaged[0]?.hook.source).toBe("eliza-managed");

    writeHook(join(workspacePath, "hooks"), "shared", {
      description: "workspace",
    });
    const afterWorkspace = await discoverHooks({
      extraDirs,
      bundledDir,
      workspacePath,
    });
    expect(afterWorkspace[0]?.hook.description).toBe("workspace");
    expect(afterWorkspace[0]?.hook.source).toBe("eliza-workspace");
  });

  it("preserves first-seen insertion order when a later source overwrites a name", async () => {
    const extraAlpha = join(root, "extra-alpha");
    const extraBeta = join(root, "extra-beta");
    const extraGamma = join(root, "extra-gamma");
    const bundledDir = join(root, "bundled");
    writeHook(extraAlpha, "alpha", { description: "extra-alpha" });
    writeHook(extraBeta, "beta", { description: "extra-beta" });
    writeHook(extraGamma, "gamma", { description: "extra-gamma" });
    writeHook(bundledDir, "alpha", { description: "bundled-alpha" });

    const hooks = await discoverHooks({
      extraDirs: [extraAlpha, extraBeta, extraGamma],
      bundledDir,
    });
    expect(hooks.map((entry) => entry.hook.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(hooks.map((entry) => entry.hook.description)).toEqual([
      "bundled-alpha",
      "extra-beta",
      "extra-gamma",
    ]);
  });

  it("returns every discovered hook with no capacity cap", async () => {
    const bundledDir = join(root, "bundled");
    for (let i = 0; i < 12; i++) {
      writeHook(bundledDir, `hook-${i}`);
    }

    const hooks = await discoverHooks({ bundledDir });
    expect(hooks).toHaveLength(12);
  });

  it("expands a leading tilde in extraDirs and workspacePath", async () => {
    const homeProbe = mkdtempSync(join(homedir(), ".eliza-hook-discovery-"));
    try {
      const extraHome = join(homeProbe, "extra");
      const workspaceHome = join(homeProbe, "workspace");
      writeHook(extraHome, "from-home-extra");
      writeHook(join(workspaceHome, "hooks"), "from-home-workspace");

      const extraTilde = extraHome.replace(homedir(), "~");
      const workspaceTilde = workspaceHome.replace(homedir(), "~");
      expect(extraTilde.startsWith("~")).toBe(true);

      const hooks = await discoverHooks({
        extraDirs: [extraTilde],
        workspacePath: workspaceTilde,
      });
      const names = hooks.map((entry) => entry.hook.name).sort();
      expect(names).toEqual(["from-home-extra", "from-home-workspace"]);
    } finally {
      rmSync(homeProbe, { recursive: true, force: true });
    }
  });
});

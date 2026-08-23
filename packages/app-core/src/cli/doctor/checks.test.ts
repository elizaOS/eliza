/**
 * Unit tests for the injectable `eliza doctor` checks. Each case drives the
 * real module against temp-dir, env, and loopback TCP fixtures so empty,
 * missing, ordering, alias, and bind-address branches are recorded as the
 * code actually behaves.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _resetCloudSecretsForTesting,
  scrubCloudSecretsFromEnv,
} from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBuildArtifacts,
  checkConfigFile,
  checkDatabase,
  checkDiskSpace,
  checkElizaWorkspace,
  checkHostConfig,
  checkModelKey,
  checkNodeModules,
  checkPort,
  checkRuntime,
  checkStateDir,
  getPortOwner,
  MODEL_KEY_VARS,
  runAllChecks,
} from "./checks.ts";

const tempDirs: string[] = [];
const originalCloudKey = process.env.ELIZAOS_CLOUD_API_KEY;

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "app-core-doctor-")),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreCloudKey(): void {
  _resetCloudSecretsForTesting();
  if (originalCloudKey === undefined) {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
  } else {
    process.env.ELIZAOS_CLOUD_API_KEY = originalCloudKey;
  }
}

function withProcessVersion<T>(version: string, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "version");
  Object.defineProperty(process, "version", {
    value: version,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "version", descriptor);
    }
  }
}

function withGlobalBun<T>(
  bun: { version: string } | undefined,
  fn: () => T,
): T {
  const g = globalThis as typeof globalThis & { Bun?: { version: string } };
  const hadBun = "Bun" in g;
  const original = g.Bun;
  if (bun === undefined) {
    Reflect.deleteProperty(g, "Bun");
  } else {
    g.Bun = bun;
  }
  try {
    return fn();
  } finally {
    if (hadBun) {
      g.Bun = original;
    } else {
      Reflect.deleteProperty(g, "Bun");
    }
  }
}

async function listenLoopback(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    server.close();
    throw new Error("listenLoopback expected an AddressInfo");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  restoreCloudKey();
  for (const dir of tempDirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MODEL_KEY_VARS", () => {
  it("lists providers in display order with the documented aliases", () => {
    expect(MODEL_KEY_VARS.map((entry) => entry.key)).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "TOGETHER_API_KEY",
      "MISTRAL_API_KEY",
      "COHERE_API_KEY",
      "PERPLEXITY_API_KEY",
      "ZAI_API_KEY",
      "MOONSHOT_API_KEY",
      "ELIZAOS_CLOUD_API_KEY",
      "OLLAMA_BASE_URL",
    ]);
    expect(
      MODEL_KEY_VARS.filter((entry) => "alias" in entry).map((entry) => [
        entry.key,
        "alias" in entry ? entry.alias : undefined,
      ]),
    ).toEqual([
      ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
      ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
      ["XAI_API_KEY", "GROK_API_KEY"],
      ["ZAI_API_KEY", "Z_AI_API_KEY"],
      ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    ]);
  });
});

describe("checkRuntime", () => {
  it("passes for Bun 1.x and fails below 1.0", () => {
    const pass = withGlobalBun({ version: "1.3.14" }, () => checkRuntime());
    expect(pass).toMatchObject({
      label: "Runtime",
      category: "system",
      status: "pass",
      detail: "Bun 1.3.14",
    });

    const fail = withGlobalBun({ version: "0.9.1" }, () => checkRuntime());
    expect(fail.status).toBe("fail");
    expect(fail.detail).toBe("Bun 0.9.1 (requires >=1.0)");
    expect(fail.fix).toMatch(/bun\.sh\/install/);
  });

  it("uses Node.js when Bun is absent, failing below 24 and on unparseable versions", () => {
    const pass = withGlobalBun(undefined, () =>
      withProcessVersion("v24.15.0", () => checkRuntime()),
    );
    expect(pass).toMatchObject({
      label: "Runtime",
      category: "system",
      status: "pass",
      detail: "Node.js v24.15.0",
    });

    const fail = withGlobalBun(undefined, () =>
      withProcessVersion("v20.19.0", () => checkRuntime()),
    );
    expect(fail.status).toBe("fail");
    expect(fail.detail).toBe("Node.js v20.19.0 (requires >=24)");
    expect(fail.fix).toMatch(/nodejs\.org/);

    const unparseable = withGlobalBun(undefined, () =>
      withProcessVersion("not-a-version", () => checkRuntime()),
    );
    expect(unparseable.status).toBe("fail");
    expect(unparseable.detail).toBe("Node.js not-a-version (requires >=24)");
  });
});

describe("checkNodeModules", () => {
  it("fails when node_modules is missing and passes when the directory exists", () => {
    const root = makeTempDir();
    const missing = checkNodeModules(root);
    expect(missing).toMatchObject({
      label: "node_modules",
      category: "system",
      status: "fail",
      detail: "Not installed",
      fix: "bun install",
      autoFixable: false,
    });

    mkdirSync(path.join(root, "node_modules"));
    const present = checkNodeModules(root);
    expect(present.status).toBe("pass");
    expect(present.detail).toBe(path.join(root, "node_modules"));
  });

  it("resolves the project root from ELIZA_PROJECT_ROOT when none is passed", () => {
    const root = makeTempDir();
    vi.stubEnv("ELIZA_PROJECT_ROOT", root);
    expect(checkNodeModules().status).toBe("fail");
    mkdirSync(path.join(root, "node_modules"));
    expect(checkNodeModules().detail).toBe(path.join(root, "node_modules"));
  });
});

describe("checkBuildArtifacts", () => {
  it("warns when dist/entry.js is absent and passes once it exists", () => {
    const root = makeTempDir();
    const missing = checkBuildArtifacts(root);
    expect(missing).toMatchObject({
      label: "Build artifacts",
      category: "system",
      status: "warn",
      detail: "dist/entry.js not found — CLI running from source",
      fix: "bun run build",
    });

    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "entry.js"), "export {};\n");
    const present = checkBuildArtifacts(root);
    expect(present.status).toBe("pass");
    expect(present.detail).toBe(path.join(root, "dist"));
  });
});

describe("checkConfigFile", () => {
  it("warns when the file is missing, fails on invalid JSON, and passes on valid JSON", () => {
    const root = makeTempDir();
    const missingPath = path.join(root, "missing.json");
    const missing = checkConfigFile(missingPath);
    expect(missing).toMatchObject({
      label: "Config file",
      category: "config",
      status: "warn",
      detail: `Not found: ${missingPath}`,
      fix: "eliza setup",
      autoFixable: true,
    });

    const invalidPath = path.join(root, "invalid.json");
    writeFileSync(invalidPath, "{not-json");
    const invalid = checkConfigFile(invalidPath);
    expect(invalid.status).toBe("fail");
    expect(invalid.detail).toBe(`Invalid JSON: ${invalidPath}`);
    expect(invalid.fix).toBe(`Edit and fix: ${invalidPath}`);

    const validPath = path.join(root, "valid.json");
    writeFileSync(validPath, '{"ok":true}');
    const valid = checkConfigFile(validPath);
    expect(valid.status).toBe("pass");
    expect(valid.detail).toBe(validPath);
  });

  it("resolves the default path from ELIZA_STATE_DIR when no configPath is given", () => {
    const root = makeTempDir();
    const result = checkConfigFile(undefined, { ELIZA_STATE_DIR: root });
    expect(result.status).toBe("warn");
    expect(result.detail).toBe(`Not found: ${path.join(root, "eliza.json")}`);
  });
});

describe("checkModelKey", () => {
  it("fails when no provider key or alias is set", () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    _resetCloudSecretsForTesting();
    const result = checkModelKey({});
    expect(result).toMatchObject({
      label: "Model API key",
      category: "config",
      status: "fail",
      detail: "No model provider API key found",
      fix: "eliza setup",
      autoFixable: true,
    });
  });

  it("prefers the first configured provider and skips blank or whitespace values", () => {
    const first = checkModelKey({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
    });
    expect(first.status).toBe("pass");
    expect(first.detail).toBe("ANTHROPIC_API_KEY set (Anthropic (Claude))");

    const skipped = checkModelKey({
      ANTHROPIC_API_KEY: "   ",
      OPENAI_API_KEY: "",
      GROQ_API_KEY: "gsk-test",
    });
    expect(skipped.detail).toBe("GROQ_API_KEY set (Groq)");
  });

  it("accepts each documented alias when the primary key is unset", () => {
    expect(checkModelKey({ CLAUDE_API_KEY: "alias-ant" }).detail).toBe(
      "CLAUDE_API_KEY set (Anthropic (Claude))",
    );
    expect(
      checkModelKey({ GOOGLE_GENERATIVE_AI_API_KEY: "alias-google" }).detail,
    ).toBe("GOOGLE_GENERATIVE_AI_API_KEY set (Google (Gemini))");
    expect(checkModelKey({ GROK_API_KEY: "alias-xai" }).detail).toBe(
      "GROK_API_KEY set (xAI (Grok))",
    );
    expect(checkModelKey({ Z_AI_API_KEY: "alias-zai" }).detail).toBe(
      "Z_AI_API_KEY set (Zai)",
    );
    expect(checkModelKey({ KIMI_API_KEY: "alias-kimi" }).detail).toBe(
      "KIMI_API_KEY set (Kimi / Moonshot)",
    );
  });

  it("reads ELIZAOS_CLOUD_API_KEY from the sealed store before the injected env", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "sealed-cloud-key";
    scrubCloudSecretsFromEnv();
    const sealed = checkModelKey({});
    expect(sealed.status).toBe("pass");
    expect(sealed.detail).toBe("ELIZAOS_CLOUD_API_KEY set (elizaOS Cloud)");

    restoreCloudKey();
    const injected = checkModelKey({ ELIZAOS_CLOUD_API_KEY: "injected-cloud" });
    expect(injected.detail).toBe("ELIZAOS_CLOUD_API_KEY set (elizaOS Cloud)");
  });
});

describe("checkStateDir", () => {
  it("warns when the directory is missing, passes when writable, and fails when not", () => {
    const missingDir = path.join(makeTempDir(), "no-such-state");
    const missing = checkStateDir({ ELIZA_STATE_DIR: missingDir });
    expect(missing).toMatchObject({
      label: "State directory",
      category: "storage",
      status: "warn",
      detail: `${missingDir} (created on first run)`,
    });

    const writableDir = makeTempDir();
    const writable = checkStateDir({ ELIZA_STATE_DIR: writableDir });
    expect(writable.status).toBe("pass");
    expect(writable.detail).toBe(writableDir);

    const lockedDir = makeTempDir();
    chmodSync(lockedDir, 0o555);
    const locked = checkStateDir({ ELIZA_STATE_DIR: lockedDir });
    expect(locked.status).toBe("fail");
    expect(locked.detail).toBe(`${lockedDir} is not writable`);
    expect(locked.fix).toBe(`chmod u+w "${lockedDir}"`);
    chmodSync(lockedDir, 0o755);
  });
});

describe("checkDatabase", () => {
  it("warns when workspace/.elizadb is missing and passes when present", () => {
    const stateDir = makeTempDir();
    const missing = checkDatabase({ ELIZA_STATE_DIR: stateDir });
    expect(missing).toMatchObject({
      label: "Database",
      category: "storage",
      status: "warn",
      detail: "Not initialized (created automatically on first start)",
    });

    const dbDir = path.join(stateDir, "workspace", ".elizadb");
    mkdirSync(dbDir, { recursive: true });
    const present = checkDatabase({ ELIZA_STATE_DIR: stateDir });
    expect(present.status).toBe("pass");
    expect(present.detail).toBe(dbDir);
  });
});

describe("checkDiskSpace", () => {
  it("passes on a real volume and skips when filesystem stats cannot be read", () => {
    const dir = makeTempDir();
    const ok = checkDiskSpace({ ELIZA_STATE_DIR: dir });
    expect(ok.label).toBe("Disk space");
    expect(ok.category).toBe("storage");
    expect(ok.status).toBe("pass");
    expect(ok.detail).toMatch(/^\d+\.\d GB free$/);

    const skipped = checkDiskSpace({
      ELIZA_STATE_DIR: path.join(dir, "no-such-volume"),
    });
    expect(skipped.status).toBe("skip");
    expect(skipped.detail).toBe("Could not read filesystem stats");
  });
});

describe("checkHostConfig", () => {
  it("warns on wildcard binds without a token, including a trailing :port", () => {
    for (const bind of ["::", "0.0.0.0", "0.0.0.0:8080"]) {
      const result = checkHostConfig({ ELIZA_API_BIND: bind });
      expect(result.status).toBe("warn");
      expect(result.detail).toMatch(/ELIZA_API_BIND=/);
      expect(result.detail).toMatch(/auto-generated each restart/);
      expect(result.detail).not.toMatch(/without ELIZA_API_TOKEN/);
    }
  });

  it("strips trailing :0 from the expanded IPv6 wildcard, so it takes the non-loopback warn", () => {
    const result = checkHostConfig({ ELIZA_API_BIND: "0:0:0:0:0:0:0:0" });
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/without ELIZA_API_TOKEN/);
  });

  it("treats bracketed IPv6 and IPv4 loopback as loopback-only", () => {
    for (const bind of ["[::1]", "localhost", "127.0.0.1"]) {
      const result = checkHostConfig({ ELIZA_API_BIND: bind });
      expect(result.status).toBe("pass");
      expect(result.detail).toBe("Loopback only (default)");
    }
  });

  it("strips a trailing :digits from ::1, so the unbracketed form is not loopback", () => {
    const result = checkHostConfig({ ELIZA_API_BIND: "::1" });
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/without ELIZA_API_TOKEN/);
  });
});

describe("checkElizaWorkspace", () => {
  it("warns when no vendored workspace exists and when eliza/ is missing package.json", () => {
    const empty = makeTempDir();
    const missing = checkElizaWorkspace(empty);
    expect(missing.status).toBe("warn");
    expect(missing.detail).toMatch(/Vendored source workspace not found/);
    expect(missing.fix).toBe("bun run setup:upstreams");

    const partial = makeTempDir();
    mkdirSync(path.join(partial, "eliza", "plugins"), { recursive: true });
    const broken = checkElizaWorkspace(partial);
    expect(broken.status).toBe("warn");
    expect(broken.detail).toBe(
      `${path.join(partial, "eliza")} exists but missing package.json`,
    );
  });

  it("passes with found locations when sources exist but core is not linked into them", () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "eliza", "plugins"), { recursive: true });
    writeFileSync(path.join(root, "eliza", "package.json"), '{"name":"eliza"}');
    const found = checkElizaWorkspace(root);
    expect(found.status).toBe("pass");
    expect(found.detail).toBe(
      "Found vendored sources at ./eliza and ./eliza/plugins (run setup:upstreams to refresh workspace links)",
    );

    const onlyRoot = makeTempDir();
    mkdirSync(path.join(onlyRoot, "eliza"));
    writeFileSync(
      path.join(onlyRoot, "eliza", "package.json"),
      '{"name":"eliza"}',
    );
    const onlyEliza = checkElizaWorkspace(onlyRoot);
    expect(onlyEliza.detail).toBe(
      "Found vendored sources at ./eliza (run setup:upstreams to refresh workspace links)",
    );
  });

  it("treats a core symlink whose realpath is prefixed by the eliza root as the active workspace", () => {
    const root = makeTempDir();
    const elizaRoot = path.join(root, "eliza");
    mkdirSync(elizaRoot);
    writeFileSync(path.join(elizaRoot, "package.json"), '{"name":"eliza"}');
    mkdirSync(path.join(root, "node_modules", "@elizaos"), { recursive: true });
    symlinkSync(elizaRoot, path.join(root, "node_modules", "@elizaos", "core"));

    const active = checkElizaWorkspace(root);
    expect(active.status).toBe("pass");
    expect(active.detail).toMatch(
      /Vendored @elizaos\/core workspace is active/,
    );
  });

  it("uses startsWith on the unresolved eliza root, so a shadow path prefixed by that root also counts as active", () => {
    const root = makeTempDir();
    const elizaRoot = path.join(root, "eliza");
    const shadow = `${elizaRoot}-shadow`;
    mkdirSync(elizaRoot);
    mkdirSync(shadow);
    writeFileSync(path.join(elizaRoot, "package.json"), '{"name":"eliza"}');
    mkdirSync(path.join(root, "node_modules", "@elizaos"), { recursive: true });
    symlinkSync(shadow, path.join(root, "node_modules", "@elizaos", "core"));

    const result = checkElizaWorkspace(root);
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(
      /Vendored @elizaos\/core workspace is active/,
    );
  });
});

describe("checkPort / getPortOwner", () => {
  it("passes when the loopback port is free", async () => {
    const held = await listenLoopback();
    const { port } = held;
    await held.close();
    const result = await checkPort(port);
    expect(result).toMatchObject({
      label: `Port ${port}`,
      category: "network",
      status: "pass",
      detail: "Available",
    });
  });

  it("warns when a process is listening, naming the owner when lsof can resolve it", async () => {
    const held = await listenLoopback();
    try {
      const owner = await getPortOwner(held.port);
      const result = await checkPort(held.port);
      expect(result.status).toBe("warn");
      expect(result.label).toBe(`Port ${held.port}`);
      if (owner) {
        expect(result.detail).toBe(`In use by ${owner}`);
        expect(owner).toMatch(/pid \d+/);
      } else {
        expect(result.detail).toBe("In use by another process");
      }
      expect(result.fix).toMatch(/^ELIZA_PORT=<other> eliza start/);
    } finally {
      await held.close();
    }
  });

  it("returns null from getPortOwner for a port with no listener", async () => {
    const held = await listenLoopback();
    const { port } = held;
    await held.close();
    expect(await getPortOwner(port)).toBeNull();
  });
});

describe("runAllChecks", () => {
  it("returns the ten sync checks in category order when checkPorts is false", async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "entry.js"), "export {};\n");
    writeFileSync(path.join(root, "config.json"), '{"ok":true}');
    mkdirSync(path.join(root, "workspace", ".elizadb"), { recursive: true });

    const results = await runAllChecks({
      env: {
        ELIZA_STATE_DIR: root,
        OPENAI_API_KEY: "sk-test",
      },
      configPath: path.join(root, "config.json"),
      projectRoot: root,
      checkPorts: false,
    });

    expect(results.map((r) => r.label)).toEqual([
      "Runtime",
      "node_modules",
      "Build artifacts",
      "Local upstreams",
      "Config file",
      "Model API key",
      "Host binding",
      "State directory",
      "Database",
      "Disk space",
    ]);
    expect(results.every((r) => r.status !== "fail")).toBe(true);
    expect(results.some((r) => r.label.startsWith("Port "))).toBe(false);
  });

  it("appends the API and UI port checks when checkPorts is not disabled", async () => {
    const api = await listenLoopback();
    const ui = await listenLoopback();
    const apiPort = api.port;
    const uiPort = ui.port;
    await api.close();
    await ui.close();

    const root = makeTempDir();
    const results = await runAllChecks({
      env: { ELIZA_STATE_DIR: root },
      projectRoot: root,
      configPath: path.join(root, "missing.json"),
      apiPort,
      uiPort,
    });

    expect(results.at(-2)?.label).toBe(`Port ${apiPort}`);
    expect(results.at(-1)?.label).toBe(`Port ${uiPort}`);
    expect(results).toHaveLength(12);
  });
});

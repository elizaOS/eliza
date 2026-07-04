/**
 * Exercises importPluginModuleFromPath()'s cold-import-in-place fast-path (F4):
 * the first import of a package name loads directly from its built dist/ root
 * with no staging copy, while re-imports, dist-less packages, and eliza-source
 * exports take their expected paths. Deterministic — real on-disk fixture
 * packages under a temp ELIZA_STATE_DIR, no live model.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importPluginModuleFromPath } from "./plugin-resolver.ts";

// The cold-import-in-place fast-path (F4) imports a plugin directly from its
// real package root on the FIRST import of a name in this process — skipping
// the `fs.cp` staging copy — when:
//   1. it is the first import of this package name in the process, AND
//   2. a built `dist/` directory exists.
// Otherwise it falls back to staging (busts the ESM module graph on re-import).
//
// This is a single, unconditional behavior — local dev and the container
// resolve plugins identically; there is no env flag.
//
// Staging lands under `<ELIZA_STATE_DIR>/plugins/.runtime-imports/<sanitized
// package name>/`. We point ELIZA_STATE_DIR at a controlled temp dir so we can
// assert, per case, whether a staging dir was created for the package.

let tmpDir: string;
let stateDir: string;
const savedEnv: Record<string, string | undefined> = {};

function rememberEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "plugin-resolver-cold-"));
  stateDir = path.join(tmpDir, "state");
  await fsp.mkdir(stateDir, { recursive: true });
  rememberEnv("ELIZA_STATE_DIR");
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function sanitize(value: string): string {
  // Mirror sanitizePluginCacheSegment in plugin-resolver.ts.
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function stagingDirFor(packageName: string): string {
  return path.join(
    stateDir,
    "plugins",
    ".runtime-imports",
    sanitize(packageName),
  );
}

async function stagingHappened(packageName: string): Promise<boolean> {
  // stagePluginImportRoot mkdir's the per-package staging base and mkdtemp's a
  // child inside it. Its presence (with at least one child) proves staging ran.
  const base = stagingDirFor(packageName);
  try {
    const entries = await fsp.readdir(base);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a git-layout fixture package directory: `installPath` IS the package
 * root. `withDist` controls whether a built `dist/index.mjs` exists. The module
 * exports a recognizable marker so we can assert it actually loaded.
 */
async function createFixture(
  packageName: string,
  marker: string,
  withDist: boolean,
): Promise<string> {
  const installPath = path.join(tmpDir, sanitize(packageName));
  await fsp.mkdir(installPath, { recursive: true });
  await fsp.writeFile(
    path.join(installPath, "package.json"),
    JSON.stringify(
      withDist
        ? { name: packageName, main: "dist/index.mjs" }
        : { name: packageName, main: "index.mjs" },
      null,
      2,
    ),
  );
  if (withDist) {
    const distDir = path.join(installPath, "dist");
    await fsp.mkdir(distDir, { recursive: true });
    await fsp.writeFile(
      path.join(distDir, "index.mjs"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );
  } else {
    await fsp.writeFile(
      path.join(installPath, "index.mjs"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );
  }
  return installPath;
}

describe("importPluginModuleFromPath cold-import-in-place fast-path (F4)", () => {
  it("prefers eliza-source exports over stale dist on workspace packages", async () => {
    const name = "cold-eliza-source-fixture";
    const installPath = path.join(tmpDir, sanitize(name));
    await fsp.mkdir(path.join(installPath, "src"), { recursive: true });
    await fsp.mkdir(path.join(installPath, "dist"), { recursive: true });
    await fsp.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify(
        {
          name,
          type: "module",
          exports: {
            "./plugin": {
              "eliza-source": {
                import: "./src/plugin.ts",
                default: "./src/plugin.ts",
              },
              import: "./dist/plugin.mjs",
              default: "./dist/plugin.mjs",
            },
          },
        },
        null,
        2,
      ),
    );
    await fsp.writeFile(
      path.join(installPath, "src", "plugin.ts"),
      "export const marker = 'source-plugin';\n",
    );
    await fsp.writeFile(
      path.join(installPath, "dist", "plugin.mjs"),
      "export const marker = 'stale-dist-plugin';\n",
    );

    const mod = (await importPluginModuleFromPath(
      installPath,
      name,
      "./plugin",
    )) as { marker: string };

    expect(mod.marker).toBe("source-plugin");
    expect(await stagingHappened(name)).toBe(false);
  });

  it("cold fast-path: dist + first import loads in place WITHOUT staging", async () => {
    const name = "cold-fastpath-fixture-a";
    const installPath = await createFixture(name, "cold-a", true);

    const mod = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
    };

    expect(mod.marker).toBe("cold-a");
    // No staging dir should have been minted for this package.
    expect(await stagingHappened(name)).toBe(false);
  });

  it("re-import stages: same name imported twice → 2nd import goes through staging", async () => {
    const name = "cold-reimport-fixture-b";
    const installPath = await createFixture(name, "reimport-b", true);

    // First import: cold fast-path, no staging.
    const first = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
    };
    expect(first.marker).toBe("reimport-b");
    expect(await stagingHappened(name)).toBe(false);

    // Second import: name already in the process Set → MUST stage.
    const second = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
    };
    expect(second.marker).toBe("reimport-b");
    expect(await stagingHappened(name)).toBe(true);
  });

  it("no dist → stages: package has no dist/ → falls back to staging", async () => {
    const name = "cold-nodist-fixture-d";
    const installPath = await createFixture(name, "nodist-d", false);

    const mod = (await importPluginModuleFromPath(installPath, name)) as {
      marker: string;
    };

    expect(mod.marker).toBe("nodist-d");
    expect(await stagingHappened(name)).toBe(true);
  });

  it("per-name keying: a cold import of one name does NOT make a different name stage", async () => {
    const nameX = "cold-keying-fixture-e1";
    const nameY = "cold-keying-fixture-e2";
    const installX = await createFixture(nameX, "keying-e1", true);
    const installY = await createFixture(nameY, "keying-e2", true);

    // Cold-import X first → its name is now in the process Set.
    const x = (await importPluginModuleFromPath(installX, nameX)) as {
      marker: string;
    };
    expect(x.marker).toBe("keying-e1");
    expect(await stagingHappened(nameX)).toBe(false);

    // Y is a DIFFERENT name → still its own first import → cold fast-path, no
    // staging. Proves the Set is keyed per-name (X's import does not poison Y).
    const y = (await importPluginModuleFromPath(installY, nameY)) as {
      marker: string;
    };
    expect(y.marker).toBe("keying-e2");
    expect(await stagingHappened(nameY)).toBe(false);
  });
});

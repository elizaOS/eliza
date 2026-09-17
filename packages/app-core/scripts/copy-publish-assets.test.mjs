/** Exercises installed build entrypoints and dependency closure in an assembled payload outside the checkout. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { copyPublishAssets } from "./copy-publish-assets.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");

it("ships consumer build tools without private repository test dependencies", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "app-core-payload-"));
  try {
    for (const root of [
      "src/styles",
      "scripts",
      "platforms",
      "packaging",
      "patches",
      "test",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, root)), { recursive: true });
      cpSync(path.join(packageRoot, root), path.join(fixture, root), {
        recursive: true,
        // Keep source tests in the input so assembly must exclude them itself;
        // installed dependencies and native build output are not fixture input.
        filter: (source) =>
          !path
            .relative(packageRoot, source)
            .split(path.sep)
            .some((part) =>
              ["node_modules", "build", "dist", "Pods", ".gradle"].includes(
                part,
              ),
            ),
      });
    }
    writeFileSync(
      path.join(fixture, "scripts", "repository-maintenance.mjs"),
      'throw new Error("Repository maintenance is not a consumer command");\n',
    );
    await copyPublishAssets({
      sourceRoot: repositoryRoot,
      destinationPackage: fixture,
    });
    // Remove the assembly inputs before exercising consumers: source siblings
    // must not accidentally satisfy dependencies missing from the payload.
    for (const entry of readdirSync(fixture)) {
      if (entry !== "dist")
        rmSync(path.join(fixture, entry), { recursive: true });
    }
    cpSync(
      path.join(repositoryRoot, "packages/elizaos/templates/project/scripts"),
      path.join(fixture, "scripts"),
      { recursive: true },
    );
    const dist = path.join(fixture, "dist");
    expect(
      existsSync(path.join(dist, "scripts/repository-maintenance.mjs")),
    ).toBe(false);
    expect(existsSync(path.join(dist, "scripts/copy-publish-assets.mjs"))).toBe(
      false,
    );
    const { resolveElectrobunDir } = await import(
      pathToFileURL(path.join(dist, "scripts/lib/app-dir.mjs")).href
    );
    const platform = resolveElectrobunDir(fixture);
    expect(realpathSync(platform)).toBe(
      realpathSync(path.join(dist, "platforms/electrobun")),
    );
    expect(existsSync(path.join(platform, "electrobun.config.ts"))).toBe(true);
    writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["apps/*"],
      }),
    );
    for (const name of ["app", "lib"]) {
      mkdirSync(path.join(fixture, "apps", name), { recursive: true });
      writeFileSync(
        path.join(fixture, "apps", name, "package.json"),
        JSON.stringify({
          name: `@fixture/${name}`,
          version: "1.0.0",
        }),
      );
    }
    const appManifest = path.join(fixture, "apps/app/package.json");
    const workspaceCheck = path.join(dist, "scripts/fix-workspace-deps.mjs");
    execFileSync(process.execPath, [workspaceCheck, "--check"], {
      cwd: fixture,
      stdio: "pipe",
    });
    const invalidManifest = JSON.stringify({
      name: "@fixture/app",
      version: "1.0.0",
      dependencies: { "@fixture/lib": "^1.0.0" },
    });
    writeFileSync(appManifest, invalidManifest);
    const invalidCheck = spawnSync(
      process.execPath,
      [workspaceCheck, "--check"],
      { cwd: fixture, encoding: "utf8" },
    );
    expect(invalidCheck.status).toBe(1);
    expect(invalidCheck.stdout + invalidCheck.stderr).toContain("@fixture/lib");
    expect(readFileSync(appManifest, "utf8")).toBe(invalidManifest);
    expect(
      readFileSync(
        path.join(dist, "scripts/lib/ios-app-store-runtime-policy.mjs"),
      ),
    ).toEqual(
      readFileSync(
        path.join(
          repositoryRoot,
          "packages/native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs",
        ),
      ),
    );
    // Bundle outside the checkout: relative imports must resolve entirely from
    // the assembled payload. Bare packages remain normal consumer dependencies.
    execFileSync(
      "bun",
      [
        "build",
        ...[
          "dev-ui",
          "run-mobile-build",
          "desktop-build",
          "dev-platform",
          "build-electrobun-preload",
        ].map((entry) => path.join(dist, `scripts/${entry}.mjs`)),
        "--packages=external",
        "--target=node",
        `--outdir=${path.join(fixture, "bundled")}`,
      ],
      { cwd: fixture, stdio: "pipe" },
    );
    expect(existsSync(path.join(dist, "scripts/lib/__tests__"))).toBe(false);
    expect(existsSync(path.join(dist, "scripts/lib/fixtures"))).toBe(false);
    expect(existsSync(path.join(dist, "test/scripts"))).toBe(false);
    expect(existsSync(path.join(dist, "test/helpers/action-spy.ts"))).toBe(
      false,
    );
    // Published script dependencies cannot point at private workspace fixtures.
    for (const entry of readdirSync(path.join(dist, "scripts"), {
      recursive: true,
    })) {
      if (!/\.[cm]?[jt]s$/.test(entry)) continue;
      const file = path.join(dist, "scripts", entry);
      for (const match of readFileSync(file, "utf8").matchAll(
        /(?:from\s*|import\s*\()(["'])([^"']+)\1/g,
      )) {
        expect(match[2], `${file}: published dependency`).not.toMatch(
          /^@elizaos\/testing(?:\/|$)/,
        );
        if (!match[2].startsWith(".")) continue;
        const dependency = path.resolve(path.dirname(file), match[2]);
        expect(dependency, `${file}: published dependency`).not.toContain(
          path.join(dist, "test") + path.sep,
        );
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);

/** Guards the published-payload manifest closure and exercises installed build entrypoints in an assembled payload outside the checkout. */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  copyPublishAssets,
  PUBLISH_ASSET_PATHS,
} from "./copy-publish-assets.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");

it("publishes the relative dependency closure of every shipped script module", () => {
  // A shipped `scripts/**` module that imports a sibling source module must
  // ship that sibling too; otherwise the installed package dies with
  // ERR_MODULE_NOT_FOUND at module resolution before any code runs. Directory
  // assets publish their whole subtree, so they satisfy their descendants.
  const publishedDirectories = PUBLISH_ASSET_PATHS.filter((asset) => {
    const absolute = path.join(packageRoot, asset);
    return existsSync(absolute) && statSync(absolute).isDirectory();
  });
  const isPublished = (dependency) =>
    PUBLISH_ASSET_PATHS.includes(dependency) ||
    publishedDirectories.some((directory) =>
      dependency.startsWith(`${directory}/`),
    );
  const missing = [];
  for (const asset of PUBLISH_ASSET_PATHS) {
    if (!asset.startsWith("scripts/") || !/\.[cm]?ts$/.test(asset)) continue;
    const file = path.join(packageRoot, asset);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(
      /(?:from\s*|import\s*\()(["'])(\.[^"']+\.[cm]?ts)\1/g,
    )) {
      const dependency = path
        .relative(packageRoot, path.resolve(path.dirname(file), match[2]))
        .split(path.sep)
        .join("/");
      if (!dependency.startsWith("scripts/")) continue;
      if (!isPublished(dependency)) {
        missing.push(`${asset} imports ${match[2]} (${dependency})`);
      }
    }
  }
  expect(
    missing,
    "shipped script dependencies missing from PUBLISH_ASSET_PATHS",
  ).toEqual([]);
});

it("ships consumer build tools without private repository test dependencies", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "app-payload-"));
  try {
    for (const root of ["src/styles", "scripts", "platforms"]) {
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
    const dist = path.join(fixture, "dist");
    expect(
      existsSync(path.join(dist, "scripts/repository-maintenance.mjs")),
    ).toBe(false);
    expect(existsSync(path.join(dist, "scripts/copy-publish-assets.ts"))).toBe(
      false,
    );
    // An installed app must not carry repository deployment and CI entrypoints.
    for (const operator of [
      "deploy-cloud-api-production-gateway.ts",
      "continue-sms-gateway-work.ts",
      "sync-homepage-porkbun-dns.ts",
      "docker-ci-smoke.sh",
      "fix-workspace-deps.ts",
      "workspace-prepare.ts",
      "playwright-ui-smoke-api-stub.ts",
      "smoke-view-declarations.ts",
    ]) {
      expect(existsSync(path.join(dist, "scripts", operator))).toBe(false);
    }
    const { resolveElectrobunDir } = await import(
      pathToFileURL(path.join(dist, "scripts/lib/app-dir.ts")).href
    );
    const platform = resolveElectrobunDir(fixture);
    expect(realpathSync(platform)).toBe(
      realpathSync(path.join(dist, "platforms/electrobun")),
    );
    expect(existsSync(path.join(platform, "electrobun.config.ts"))).toBe(true);
    expect(
      readFileSync(
        path.join(dist, "scripts/lib/ios-app-store-runtime-policy.ts"),
      ),
    ).toEqual(
      readFileSync(
        path.join(
          repositoryRoot,
          "packages/scripts/plugins/plugin-native-bun-runtime/engine/ios-app-store-runtime-policy.ts",
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
});

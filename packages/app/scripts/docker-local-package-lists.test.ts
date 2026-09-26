/** Tests manifest-driven Docker runtime closure with real isolated workspace manifests. */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectDockerWorkspaceDirs } from "./collect-docker-runtime-deps.ts";

const roots = [];
function workspace(packages) {
  const root = mkdtempSync(path.join(os.tmpdir(), "docker-closure-"));
  roots.push(root);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  for (const [directory, manifest] of Object.entries(packages)) {
    const dir = path.join(root, "packages", directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Docker runtime dependency closure", () => {
  it("loads plugin UI grammars through the image's pinned tsx loader", () => {
    const require = createRequire(import.meta.url);
    const dockerfile = readFileSync(
      new URL("../deploy/Dockerfile.ci", import.meta.url),
      "utf8",
    );
    const loaderVersion = dockerfile.match(/--no-save tsx@([\d.]+)/)?.[1];
    expect(loaderVersion).toBe(require("tsx/package.json").version);
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `
          import { createElement } from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { SyntaxHighlighter } from './prism-light.ts';
          process.stdout.write(renderToStaticMarkup(
            createElement(SyntaxHighlighter, { language: 'typescript' }, 'const answer = 42;'),
          ));
        `,
      ],
      {
        cwd: fileURLToPath(
          new URL("../../ui/src/cloud-ui/components/code/", import.meta.url),
        ),
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("../deploy/tsx-runtime-tsconfig.json", import.meta.url),
          ),
        },
      },
    );
    expect(output).toContain("<pre");
    expect(output).toContain("<span");
    expect(output.replace(/<[^>]+>/g, "")).toBe("const answer = 42;");
  });

  it("emits the JavaScript dependencies required by shipped plugins and UI exports", () => {
    const names = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./collect-docker-runtime-deps.ts", import.meta.url),
        ),
        "--names",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(names).toContain("git-workspace-service");
    expect(names).toContain("@capacitor/core");
    expect(names).toContain("@radix-ui/react-tooltip");
    expect(names).not.toContain("@capacitor/cli");
  });

  it("includes transitive and cyclic runtime dependencies once, without development or optional dependencies", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/sql": "workspace:*" },
        devDependencies: { "dev-only": "workspace:*" },
        optionalDependencies: { "optional-only": "workspace:*" },
        peerDependencies: { "optional-peer": "workspace:*" },
        peerDependenciesMeta: { "optional-peer": { optional: true } },
      },
      sql: {
        name: "@elizaos/sql",
        dependencies: { "@elizaos/core": "workspace:*", pg: "8.23.0" },
      },
      core: {
        name: "@elizaos/core",
        dependencies: { "@elizaos/sql": "workspace:*" },
      },
    });
    expect(
      collectDockerWorkspaceDirs(root, ["packages/agent"]).map((dir) =>
        path.relative(root, dir),
      ),
    ).toEqual(["packages/agent", "packages/sql", "packages/core"]);
  });

  it("fails with the owning consumer when a declared runtime workspace is absent", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/missing": "workspace:*" },
      },
    });
    expect(() => collectDockerWorkspaceDirs(root, ["packages/agent"])).toThrow(
      "Missing runtime workspace @elizaos/missing required by @elizaos/agent",
    );
  });

  it("includes UI runtime dependencies loaded through plugin exports", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/ui": "workspace:*" },
      },
      ui: {
        name: "@elizaos/ui",
        dependencies: { "@elizaos/auth": "workspace:*" },
        devDependencies: { "browser-build-only": "workspace:*" },
      },
      auth: {
        name: "@elizaos/auth",
      },
    });
    expect(
      collectDockerWorkspaceDirs(root, ["packages/agent"]).map((dir) =>
        path.relative(root, dir),
      ),
    ).toEqual(["packages/agent", "packages/ui", "packages/auth"]);
  });
});

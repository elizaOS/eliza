import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "./lib/release-check-pack-dry-run";
import { findNonWorkspaceDependencySpecs } from "./release-check";

describe("release-check pack dry-run guard", () => {
  it("treats broad publish roots as pack hotspots", () => {
    const hotspots = findLocalPackHotspots(
      ["dist", "packages/app/dist", "dist/node_modules"],
      (candidate) => candidate === "dist" || candidate === "packages/app/dist",
    );

    expect(hotspots).toEqual(["dist", "packages/app/dist"]);
  });

  it("skips the exact pack dry-run in CI when hotspot artifacts are present", () => {
    expect(
      shouldSkipExactPackDryRun(["dist", "packages/app/dist"], { CI: "true" }),
    ).toBe(true);
  });

  it("honors the explicit exact-pack override", () => {
    expect(
      shouldSkipExactPackDryRun(["dist"], { ELIZA_FORCE_PACK_DRY_RUN: "1" }),
    ).toBe(false);
  });
});

describe("release-check cloud-agent template guard", () => {
  it("accepts workspace-local elizaOS dependencies in source", () => {
    expect(
      findNonWorkspaceDependencySpecs(
        {
          dependencies: {
            "@elizaos/core": "workspace:*",
            "@elizaos/plugin-sql": "workspace:*",
          },
        },
        ["@elizaos/core", "@elizaos/plugin-sql"],
      ),
    ).toEqual([]);
  });

  it("rejects committed alpha pins in the source template", () => {
    expect(
      findNonWorkspaceDependencySpecs(
        {
          dependencies: {
            "@elizaos/core": "2.0.0-alpha.341",
          },
        },
        ["@elizaos/core"],
      ),
    ).toEqual([
      {
        name: "@elizaos/core",
        specifier: "2.0.0-alpha.341",
      },
    ]);
  });
});

describe("Docker runtime tsx config", () => {
  it("does not let tsx resolve workspace packages back to source paths", () => {
    const dockerfile = readFileSync(
      new URL("../deploy/Dockerfile.ci", import.meta.url),
      "utf8",
    );
    const runtimeTsconfig = JSON.parse(
      readFileSync(
        new URL("../deploy/tsx-runtime-tsconfig.json", import.meta.url),
        "utf8",
      ),
    );

    expect(dockerfile).toContain(
      "ENV TSX_TSCONFIG_PATH=${APP_CORE_DIR}/deploy/tsx-runtime-tsconfig.json",
    );
    expect(runtimeTsconfig.compilerOptions?.paths).toBeUndefined();
  });
});

describe("agent packaged runtime dependencies", () => {
  it("creates the root @elizaos/agent Docker runtime alias", () => {
    const relinker = readFileSync(
      new URL("./relink-workspace-packages-to-dist.mjs", import.meta.url),
      "utf8",
    );

    expect(relinker).toContain(
      "new Set([getNodeModulesEntry(root, packageName)])",
    );
  });

  it("keeps agent package-local runtime dependencies in the Docker context", () => {
    const dockerignore = readFileSync(
      new URL("../deploy/.dockerignore.ci", import.meta.url),
      "utf8",
    );

    expect(dockerignore).toContain("!packages/agent/node_modules/**");
    expect(dockerignore).toContain("!eliza/packages/agent/node_modules/**");
    expect(dockerignore).toContain("!apps/app-elizamaker/node_modules/**");
    expect(dockerignore).toContain("!apps/app-lifeops/node_modules/**");
    expect(dockerignore).toContain("!apps/app-steward/node_modules/**");
  });

  it("declares statically imported bundled plugins", () => {
    const runtimeEntry = readFileSync(
      new URL("../../agent/src/runtime/eliza.ts", import.meta.url),
      "utf8",
    );
    const agentPackage = JSON.parse(
      readFileSync(
        new URL("../../agent/package.json", import.meta.url),
        "utf8",
      ),
    );

    expect(runtimeEntry).toContain('from "@elizaos/plugin-agent-skills"');
    expect(agentPackage.dependencies?.["@elizaos/plugin-agent-skills"]).toBe(
      "workspace:*",
    );
  });

  it("relinks statically imported local plugins into the Docker image", () => {
    const relinker = readFileSync(
      new URL("./link-docker-local-app-packages.mjs", import.meta.url),
      "utf8",
    );

    expect(relinker).toContain(
      '"eliza/plugins/plugin-agent-skills/typescript"',
    );
    expect(relinker).toContain('"eliza/packages/shared"');
    expect(relinker).toContain('"eliza/packages/skills"');
    expect(relinker).toContain(
      '"eliza/plugins/plugin-local-embedding/typescript"',
    );
    expect(relinker).toContain('"eliza/plugins/plugin-pdf/typescript"');
  });

  it("keeps local embeddings optional during packaged startup", () => {
    const runtimeEntry = readFileSync(
      new URL("../../agent/src/runtime/eliza.ts", import.meta.url),
      "utf8",
    );

    expect(runtimeEntry).not.toContain(
      'from "@elizaos/plugin-local-embedding"',
    );
    expect(runtimeEntry).toContain(
      'await import("@elizaos/plugin-local-embedding")',
    );
  });

  it("keeps runtime app plugins off the agent root barrel", () => {
    const companionPlugin = readFileSync(
      new URL("../../../apps/app-companion/src/plugin.ts", import.meta.url),
      "utf8",
    );
    const companionEmoteAction = readFileSync(
      new URL(
        "../../../apps/app-companion/src/actions/emote.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const appBlockerEngine = readFileSync(
      new URL(
        "../../../apps/app-lifeops/src/app-blocker/engine.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(companionPlugin).toContain(
      '"@elizaos/agent/services/app-session-gate"',
    );
    expect(companionEmoteAction).toContain('"@elizaos/agent/security/access"');
    expect(appBlockerEngine).toContain(
      '"@elizaos/app-core/bridge/native-plugins"',
    );
    expect(companionPlugin).not.toContain('"@elizaos/agent"');
    expect(companionEmoteAction).not.toContain('"@elizaos/agent"');
    expect(appBlockerEngine).not.toContain('"@elizaos/agent"');
  });

  it("keeps agent API exports on agent-owned transaction helpers", () => {
    const agentApiIndex = readFileSync(
      new URL("../../agent/src/api/index.ts", import.meta.url),
      "utf8",
    );
    const registryService = readFileSync(
      new URL("../../agent/src/api/registry-service.ts", import.meta.url),
      "utf8",
    );

    expect(agentApiIndex).toContain('from "./tx-service.js"');
    expect(registryService).toContain('from "./tx-service.js"');
    expect(agentApiIndex).not.toContain("@elizaos/app-steward/api/tx-service");
    expect(registryService).not.toContain(
      "@elizaos/app-steward/api/tx-service",
    );
  });
});

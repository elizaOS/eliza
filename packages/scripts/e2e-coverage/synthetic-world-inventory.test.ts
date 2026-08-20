/** Exercises the canonical runtime-surface inventory and drift ratchet with deterministic repository fixtures. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isKeylessScenarioSource } from "./generate-synthetic-world-manifest.ts";
import {
  auditPluginPackageCoverage,
  buildSyntheticWorldInventory,
  discoverRuntimeSurfaces,
  evaluateSyntheticWorldDrift,
  isExecutableBoundaryEvidence,
  projectLegacyPluginSurfaces,
  type SurfaceRegistration,
  SYNTHETIC_WORLD_SCHEMA,
  type SyntheticWorldManifest,
} from "./synthetic-world-inventory.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "synthetic-world-inventory-"),
  );
  const plugin = path.join(root, "plugins", "plugin-fixture");
  mkdirSync(path.join(plugin, "src"), { recursive: true });
  writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "@elizaos/plugin-fixture" }),
  );

  const rootPlugin = path.join(root, "plugins", "plugin-root-entry");
  mkdirSync(rootPlugin, { recursive: true });
  writeFileSync(
    path.join(rootPlugin, "package.json"),
    JSON.stringify({
      name: "@elizaos/plugin-root-entry",
      exports: {
        ".": { "eliza-source": "./index.ts", default: "./dist/index.js" },
      },
    }),
  );
  writeFileSync(
    path.join(rootPlugin, "index.ts"),
    `import type { Plugin } from "@elizaos/core";
     export default { name: "root", providers: [{ name: "ROOT_PROVIDER" }], models: { TEXT_LARGE: () => "ok" } } satisfies Plugin;`,
  );
  writeFileSync(
    path.join(plugin, "src", "surfaces.ts"),
    `
      export const firstAction = {
        name: "FIRST_ACTION",
        parameters: [{ name: "mode", subactions: ["create", "delete"] }],
      };
      export const actionFactory = () => [firstAction, { name: "SECOND_ACTION" }];
      export const providers = [{ name: "FIXTURE_CONTEXT" }];
      export class FixtureService {}
      export const routes = [{ path: "/fixture" }];
    `,
  );
  writeFileSync(
    path.join(plugin, "src", "index.ts"),
    `
      import type { Plugin } from "@elizaos/core";
      import { actionFactory, FixtureService, providers, routes } from "./surfaces.js";
      const base: Plugin = {
        name: "base",
        actions: [...actionFactory()],
        providers,
        services: [FixtureService],
        events: { MESSAGE_RECEIVED: [() => undefined] },
      };
      export default {
        ...base,
        name: "fixture",
        routes: [...routes],
        views: [{ id: "fixture-view", path: "/fixture" }],
        models: { TEXT_SMALL: () => "ok" },
        connectorSources: [{ source: "fixture-chat" }],
      } satisfies Plugin;
    `,
  );

  const cloudApi = path.join(root, "packages", "cloud", "api");
  mkdirSync(path.join(cloudApi, "src"), { recursive: true });
  mkdirSync(path.join(cloudApi, "v1", "mounted"), { recursive: true });
  mkdirSync(path.join(cloudApi, "v1", "dead"), { recursive: true });
  writeFileSync(
    path.join(cloudApi, "package.json"),
    JSON.stringify({ name: "@elizaos/cloud-api" }),
  );
  writeFileSync(
    path.join(cloudApi, "v1", "mounted", "route.ts"),
    `import { Hono } from "hono"; export default new Hono();`,
  );
  writeFileSync(
    path.join(cloudApi, "v1", "dead", "route.ts"),
    `export default {};`,
  );
  writeFileSync(
    path.join(cloudApi, "src", "_router.generated.ts"),
    `import mounted from "../v1/mounted/route"; void mounted;`,
  );
  writeFileSync(
    path.join(cloudApi, "src", "bootstrap-app.ts"),
    `const app = { get() {} }; app.get("/manual-health", () => undefined);`,
  );
  return root;
}

describe("synthetic-world production inventory", () => {
  test("follows plugin imports, factories, arrays, spreads, subactions, and maps", () => {
    const root = fixtureRoot();
    try {
      const rows = discoverRuntimeSurfaces(root);
      const signatures = rows.map((row) => `${row.kind}:${row.name}`);
      expect(signatures).toContain("action:FIRST_ACTION");
      expect(signatures).toContain("action:SECOND_ACTION");
      expect(signatures).toContain("subaction:FIRST_ACTION/create");
      expect(signatures).toContain("subaction:FIRST_ACTION/delete");
      expect(signatures).toContain("provider:FIXTURE_CONTEXT");
      expect(signatures).toContain("service:FixtureService");
      expect(signatures).toContain("event:MESSAGE_RECEIVED");
      expect(signatures).toContain("route:/fixture");
      expect(signatures).toContain("view:fixture-view");
      expect(signatures).toContain("model:TEXT_SMALL");
      expect(signatures).toContain("connector-ingress:fixture-chat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the generated Cloud router and manual mounts as served-route authority", () => {
    const root = fixtureRoot();
    try {
      const routes = discoverRuntimeSurfaces(root)
        .filter(
          (row) => row.owner === "packages/cloud/api" && row.kind === "route",
        )
        .map((row) => row.name);
      expect(routes).toContain("/v1/mounted");
      expect(routes).toContain("/manual-health");
      expect(routes).not.toContain("/v1/dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the #8801 compatibility projection", () => {
    const root = fixtureRoot();
    try {
      expect(
        projectLegacyPluginSurfaces(discoverRuntimeSurfaces(root)),
      ).toContainEqual({
        dir: "plugin-fixture",
        packageName: "@elizaos/plugin-fixture",
        hasActions: true,
        hasConnector: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("includes root-entry/no-src packages and audits manifest parity", () => {
    const root = fixtureRoot();
    try {
      const signatures = discoverRuntimeSurfaces(root).map(
        (row) => `${row.kind}:${row.name}`,
      );
      expect(signatures).toContain("provider:ROOT_PROVIDER");
      expect(signatures).toContain("model:TEXT_LARGE");
      expect(auditPluginPackageCoverage(root)).toMatchObject({
        manifests: ["plugin-fixture", "plugin-root-entry"],
        scanned: ["plugin-fixture", "plugin-root-entry"],
        omitted: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("synthetic-world disposition ratchet", () => {
  const registration: SurfaceRegistration = {
    id: "plugin-fixture:action:FIRST_ACTION",
    kind: "action",
    name: "FIRST_ACTION",
    owner: "plugin-fixture",
    packageName: "@elizaos/plugin-fixture",
    source: "plugins/plugin-fixture/src/index.ts",
    platformRequirements: [],
    externalDependencies: [],
  };

  test("accepts every supported status when it has a written reason", () => {
    for (const status of [
      "exempt",
      "platform-deferred",
      "provider-qualified-only",
      "unsupported-product",
    ] as const) {
      const manifest: SyntheticWorldManifest = {
        schema: SYNTHETIC_WORLD_SCHEMA,
        dispositions: {
          [registration.id]: {
            status,
            reason: `A sufficiently detailed fixture reason for ${status}.`,
          },
        },
      };
      expect(evaluateSyntheticWorldDrift([registration], manifest).ok).toBe(
        true,
      );
    }
  });

  test("fails new, stale, short-reason, and larp-covered dispositions", () => {
    const missing: SyntheticWorldManifest = {
      schema: SYNTHETIC_WORLD_SCHEMA,
      dispositions: {},
    };
    expect(
      evaluateSyntheticWorldDrift([registration], missing).newlyUncovered,
    ).toEqual([registration.id]);

    const stale: SyntheticWorldManifest = {
      schema: SYNTHETIC_WORLD_SCHEMA,
      dispositions: {
        stale: {
          status: "exempt",
          reason: "A sufficiently detailed stale reason.",
        },
      },
    };
    expect(evaluateSyntheticWorldDrift([], stale).stale).toEqual(["stale"]);

    const invalid: SyntheticWorldManifest = {
      schema: SYNTHETIC_WORLD_SCHEMA,
      dispositions: {
        [registration.id]: {
          status: "covered",
          reason: "too short",
          artifacts: [],
          boundarySignals: [],
        },
      },
    };
    expect(
      evaluateSyntheticWorldDrift([registration], invalid).invalid,
    ).toEqual([registration.id]);
  });

  test("does not treat comments, setup, or fixture-name mentions as executable evidence", () => {
    const mentions = [
      `// expected actionName: "FIRST_ACTION"`,
      `const fixture = { actionName: "FIRST_ACTION" };`,
      `requires: { plugins: ["@elizaos/plugin-fixture"] }; const name = "FIRST_ACTION";`,
    ];
    for (const source of mentions) {
      expect(isExecutableBoundaryEvidence(registration, source)).toBe(false);
    }
    expect(
      isExecutableBoundaryEvidence(
        registration,
        `finalChecks: [{ type: "actionCalled", actionName: "FIRST_ACTION", minCount: 1 }]`,
      ),
    ).toBe(true);

    const route = {
      ...registration,
      id: "plugin-fixture:route:/fixture",
      kind: "route" as const,
      name: "/fixture",
    };
    expect(
      isExecutableBoundaryEvidence(
        route,
        `// request.get("/fixture"); expect(response)`,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        route,
        `const response = await request.get("/fixture"); expect(response.status()).toBe(200);`,
      ),
    ).toBe(true);
  });

  test("uses explicit scenario lane metadata instead of deterministic-directory placement", () => {
    expect(
      isKeylessScenarioSource(`export default { id: "absent-lane" };`),
    ).toBe(false);
    expect(
      isKeylessScenarioSource(
        `export default { id: "explicit-live", lane: "live-only" };`,
      ),
    ).toBe(false);
    expect(
      isKeylessScenarioSource(
        `export default { id: "explicit-pr", lane: "pr-deterministic" };`,
      ),
    ).toBe(true);
  });

  test("machine report groups owners, dependencies, lanes, and workstreams", () => {
    const root = fixtureRoot();
    try {
      const rows = discoverRuntimeSurfaces(root);
      const manifest: SyntheticWorldManifest = {
        schema: SYNTHETIC_WORLD_SCHEMA,
        dispositions: Object.fromEntries(
          rows.map((row) => [
            row.id,
            {
              status: "exempt" as const,
              reason: "A sufficiently detailed grouped-report fixture reason.",
              deterministicScenarioIds: ["fixture-keyless"],
              workstream: "fixture-workstream",
            },
          ]),
        ),
      };
      const inventory = buildSyntheticWorldInventory(root, manifest);
      expect(inventory.schema).toBe(SYNTHETIC_WORLD_SCHEMA);
      expect(inventory.summary.total).toBe(rows.length);
      expect(inventory.summary.byOwner["plugin-fixture"]).toBeGreaterThan(0);
      expect(inventory.summary.byScenarioLane["pr-deterministic"]).toBe(
        rows.length,
      );
      expect(inventory.summary.byWorkstream["fixture-workstream"]).toBe(
        rows.length,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

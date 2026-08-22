/**
 * Exercises the report-only production-registration inventory with the real
 * repository plus deterministic adversarial fixtures. No plugin module,
 * provider client, or external credential is loaded.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareRuntimeSurfaceInventories,
  inspectRuntimeSurfaceHealth,
} from "./check-runtime-surface-coverage.ts";
import {
  buildRuntimeSurfaceInventory,
  isDeterministicScenarioSource,
  isExecutableBoundaryEvidence,
  packageEntryPoints,
  RUNTIME_SURFACE_REPO_ROOT,
  RUNTIME_SURFACE_SCHEMA,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceKind,
  type RuntimeSurfaceRow,
  type RuntimeSurfaceStatus,
  reachableProductionFiles,
  runtimeSurfaceId,
  scenarioMetadataFromSource,
  scenarioOwnsSurface,
  servedCloudRouteFiles,
  workerBindingsFromSource,
} from "./runtime-surface-inventory.ts";

function row(
  id: string,
  status: RuntimeSurfaceStatus,
  overrides: Partial<RuntimeSurfaceRow> = {},
): RuntimeSurfaceRow {
  return {
    id,
    kind: "action",
    surfaceName: id,
    owner: "@elizaos/test-owner",
    packageName: "@elizaos/test-package",
    packageDir: "plugins/plugin-test",
    sourcePath: "plugins/plugin-test/src/index.ts",
    registrationField: "actions",
    runtimeRequirements: [],
    platformRequirements: [],
    packageDependencies: [],
    externalServiceDependencies: [],
    mockDependencies: [],
    dependencyDisposition: "local-only",
    mockAvailability: status === "covered" ? "available" : "missing",
    mockFidelity: "deterministic fixture",
    resetSupport: status === "covered" ? "partial" : "missing",
    deterministicScenarioIds: status === "covered" ? ["fixture-scenario"] : [],
    liveModelScenarioIds: [],
    cloudE2eCells: [],
    evidenceClass: status === "covered" ? "synthetic" : "none",
    boundaryArtifacts:
      status === "covered"
        ? ["packages/test/scenarios/fixture.scenario.ts"]
        : [],
    boundarySignals: status === "covered" ? [id] : [],
    workstream: "#22898",
    status,
    reason:
      "Fixture classification has an explicit and actionable written reason.",
    ...overrides,
  };
}

function inventory(rows: RuntimeSurfaceRow[]): RuntimeSurfaceInventory {
  return {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedAt: "2026-08-20T00:00:00.000Z",
    sourceRevision: "fixture",
    packages: [],
    rows,
    summary: {
      total: rows.length,
      byKind: {},
      byStatus: {},
      byDependencyDisposition: {},
    },
    gaps: {
      byOwner: {},
      byExternalService: {},
      byMockOwner: {},
      byScenarioLane: {},
      byWorkstream: {},
    },
  };
}

describe("runtime-surface production inventory", () => {
  const realInventory = buildRuntimeSurfaceInventory({
    generatedAt: "2026-08-20T00:00:00.000Z",
  });

  test("reports a structurally valid production census without a frozen baseline", () => {
    expect(inspectRuntimeSurfaceHealth(realInventory)).toMatchObject({
      ok: true,
      duplicateRows: [],
      invalidCoverage: [],
      coveredWithoutMockOwner: [],
    });
    expect(realInventory.rows.some((row) => row.status === "covered")).toBe(
      true,
    );
    expect(
      realInventory.rows.some((row) => row.deterministicScenarioIds.length > 0),
    ).toBe(true);
    expect(realInventory.rows.some((row) => row.cloudE2eCells.length > 0)).toBe(
      true,
    );
  });

  test("covers every declared runtime kind with source-backed canonical rows", () => {
    expect(realInventory.rows.length).toBeGreaterThan(700);
    const kinds = new Set(realInventory.rows.map((entry) => entry.kind));
    const requiredKinds: RuntimeSurfaceKind[] = [
      "action",
      "subaction",
      "provider",
      "service",
      "evaluator",
      "event-handler",
      "route",
      "view",
      "model-handler",
      "connector-ingress",
      "connector-egress",
      "scheduled-worker",
      "native-bridge",
      "cloud-service",
    ];
    for (const required of requiredKinds) {
      expect(kinds.has(required), `missing ${required}`).toBe(true);
    }
    for (const surface of realInventory.rows) {
      expect(
        existsSync(path.join(RUNTIME_SURFACE_REPO_ROOT, surface.sourcePath)),
      ).toBe(true);
      expect(surface.owner.length).toBeGreaterThan(0);
      expect(surface.reason.length).toBeGreaterThan(23);
      expect(surface.id).not.toMatch(/:(?:packages|plugins)\//);
    }
    expect(new Set(realInventory.rows.map((surface) => surface.id)).size).toBe(
      realInventory.rows.length,
    );
    expect(
      realInventory.rows.filter((surface) =>
        [
          "@elizaos/core:scheduled-worker:onetime_test_task",
          "@elizaos/core:scheduled-worker:repeating_test_task",
          "@elizaos/core:scheduled-worker:taskname",
        ].includes(surface.id),
      ),
    ).toEqual([]);
    const ids = new Set(realInventory.rows.map((surface) => surface.id));
    expect(ids.has("@elizaos/agent:service:media_generation")).toBe(true);
    expect(ids.has("@elizaos/agent:service:eliza_permissions_registry")).toBe(
      true,
    );
    expect(ids.has("@elizaos/agent:service:agentmediagenerationservice")).toBe(
      false,
    );
  });

  test("accounts for every maintained plugin and host package, including packages with no registration", () => {
    const pluginPackages = realInventory.packages.filter((entry) =>
      entry.packageDir.startsWith("plugins/"),
    );
    const maintainedPluginCount = readdirSync(
      path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins"),
    ).filter((entry) =>
      existsSync(
        path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins", entry, "package.json"),
      ),
    ).length;
    expect(pluginPackages.length).toBe(maintainedPluginCount);
    expect(
      realInventory.packages.find(
        (entry) => entry.packageName === "@elizaos/plugin-google-genai",
      ),
    ).toMatchObject({ registrationState: "registered-surfaces" });
    expect(
      realInventory.packages.find(
        (entry) => entry.packageName === "@elizaos/cloud-api",
      ),
    ).toMatchObject({ registrationState: "registered-surfaces" });
    const maintainedCloudServices = readdirSync(
      path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/services"),
    ).filter(
      (entry) =>
        !entry.startsWith("_") &&
        existsSync(
          path.join(
            RUNTIME_SURFACE_REPO_ROOT,
            "packages/cloud/services",
            entry,
            "package.json",
          ),
        ),
    );
    for (const service of maintainedCloudServices) {
      expect(
        realInventory.packages.some(
          (entry) =>
            entry.packageDir === `packages/cloud/services/${service}` &&
            entry.registrationState === "registered-surfaces",
        ),
        `missing Cloud service package ${service}`,
      ).toBe(true);
    }
    expect(
      realInventory.packages.find(
        (entry) => entry.packageName === "@elizaos/native-plugin-shared-types",
      ),
    ).toMatchObject({
      registrationState: "no-runtime-registration",
      registeredSurfaceIds: [],
    });
    for (const packageRecord of realInventory.packages) {
      expect(packageRecord.reason.length).toBeGreaterThan(23);
    }
  });

  test("follows spreads, factories, promoted subactions, platform exports, and host config", () => {
    const has = (predicate: (entry: RuntimeSurfaceRow) => boolean): boolean =>
      realInventory.rows.some(predicate);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-todos" &&
          entry.kind === "view" &&
          entry.surfaceName === "todos",
      ),
    ).toBe(true);
    expect(
      realInventory.rows
        .filter((entry) => entry.kind === "model-handler")
        .every((entry) => !/_MODEL_TYPE$/.test(entry.surfaceName)),
    ).toBe(true);
    const cliInferenceModels = new Set(
      realInventory.rows
        .filter(
          (entry) =>
            entry.packageName === "@elizaos/plugin-cli-inference" &&
            entry.kind === "model-handler",
        )
        .map((entry) => entry.surfaceName),
    );
    expect(cliInferenceModels).toEqual(
      new Set([
        "ACTION_PLANNER",
        "RESPONSE_HANDLER",
        "TEXT_LARGE",
        "TEXT_MEDIUM",
        "TEXT_MEGA",
        "TEXT_NANO",
        "TEXT_SMALL",
      ]),
    );
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-inmemorydb" &&
          entry.kind === "service" &&
          entry.surfaceName === "database-adapter",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-app-manager" &&
          entry.kind === "route" &&
          entry.surfaceName === "handleAppsRoutes",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-registry" &&
          entry.kind === "service" &&
          entry.surfaceName === "installPlugin",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-google-genai" &&
          entry.kind === "model-handler" &&
          entry.surfaceName === "TEXT_SMALL",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-fish-audio" &&
          entry.kind === "model-handler" &&
          entry.surfaceName === "TEXT_TO_SPEECH",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-native-inference" &&
          entry.kind === "model-handler",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-browser" &&
          entry.kind === "subaction" &&
          entry.surfaceName.includes("BROWSER_"),
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.kind === "native-bridge" &&
          entry.platformRequirements.includes("native-host"),
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/cloud-api" && entry.kind === "route",
      ),
    ).toBe(true);
    expect(has((entry) => entry.kind === "cloud-service")).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/core" &&
          entry.kind === "scheduled-worker" &&
          entry.surfaceName === "BATCHER_DRAIN",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-wechat" &&
          entry.kind === "connector-ingress" &&
          entry.surfaceName === "wechat",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-discord" &&
          entry.kind === "connector-ingress" &&
          entry.surfaceName === "discord",
      ),
    ).toBe(true);
    expect(
      realInventory.rows
        .filter((entry) =>
          [
            "scheduled-worker",
            "queue",
            "connector-ingress",
            "connector-egress",
          ].includes(entry.kind),
        )
        .every(
          (entry) =>
            !entry.surfaceName.includes("=>") &&
            !entry.surfaceName.includes("{ name:") &&
            !entry.registrationField.endsWith(".catch"),
        ),
    ).toBe(true);
  });

  test("covered means an executable artifact plus its exact boundary signal", () => {
    for (const surface of realInventory.rows.filter(
      (entry) => entry.status === "covered",
    )) {
      expect(surface.boundaryArtifacts.length).toBeGreaterThan(0);
      expect(surface.boundarySignals).toEqual([
        surface.id,
        surface.surfaceName,
      ]);
      expect(
        surface.deterministicScenarioIds.length + surface.cloudE2eCells.length,
      ).toBeGreaterThan(0);
    }
  });

  test("reports gaps by owner, dependency, lane, and synthetic-world workstream", () => {
    expect(Object.keys(realInventory.gaps.byOwner).length).toBeGreaterThan(0);
    expect(
      Object.keys(realInventory.gaps.byExternalService).length,
    ).toBeGreaterThan(0);
    expect(
      realInventory.gaps.byScenarioLane["missing-deterministic"]?.length,
    ).toBeGreaterThan(0);
    expect(Object.keys(realInventory.gaps.byWorkstream).sort()).toEqual(
      expect.arrayContaining([
        "#22899",
        "#22901",
        "#22902",
        "#22904",
        "#23268",
        "#23270",
      ]),
    );
    expect(realInventory.gaps.byWorkstream.unassigned).toBeUndefined();
  });
});

describe("runtime-surface adversarial ratchet", () => {
  test("requires an explicit deterministic lane instead of inferring it from location", () => {
    expect(
      isDeterministicScenarioSource("export default { id: 'absent' }"),
    ).toBe(false);
    expect(
      isDeterministicScenarioSource(
        "export default { id: 'live', lane: 'live-only' }",
      ),
    ).toBe(false);
    expect(
      isDeterministicScenarioSource(
        "export default { id: 'pr', lane: 'pr-deterministic' }",
      ),
    ).toBe(true);
  });

  test("binds scenario ownership to the scenario object, not comment or string decoys", () => {
    expect(
      scenarioMetadataFromSource(`
        // requires: { plugins: ['@elizaos/plugin-decoy'] }
        const text = "requires: { plugins: ['@elizaos/plugin-string-decoy'] }";
        export default {
          id: 'real-scenario',
          requires: { plugins: ['@elizaos/plugin-real'] },
        };
      `),
    ).toEqual({
      id: "real-scenario",
      plugins: ["@elizaos/plugin-real"],
      runtimeSurfaceIds: [],
      lane: null,
    });
    expect(
      isDeterministicScenarioSource(`
        const decoy = { lane: 'pr-deterministic' };
        export default { id: 'live', lane: 'live-only', requires: { plugins: [] } };
      `),
    ).toBe(false);
    expect(scenarioOwnsSurface("packages/agent", ["@elizaos/agent"], [])).toBe(
      false,
    );
    expect(
      scenarioOwnsSurface(
        "packages/agent",
        ["@elizaos/agent"],
        ["@elizaos/agent"],
      ),
    ).toBe(true);
    expect(
      scenarioOwnsSurface(
        "plugins/plugin-decoy",
        ["@elizaos/plugin-decoy"],
        [],
      ),
    ).toBe(false);
    expect(
      scenarioMetadataFromSource(`
        export const decoy = { id: 'decoy', lane: 'pr-deterministic' };
        export default { id: 'canonical', lane: 'live-only' };
      `),
    ).toEqual({
      id: "canonical",
      plugins: [],
      runtimeSurfaceIds: [],
      lane: "live-only",
    });
    expect(
      scenarioMetadataFromSource(`
        export default scenario({
          id: 'wrapped-canonical',
          lane: 'pr-deterministic',
          requires: { plugins: ['@elizaos/plugin-real'] },
          runtimeSurfaceIds: ['@elizaos/plugin-real:service:real'],
        });
      `),
    ).toEqual({
      id: "wrapped-canonical",
      plugins: ["@elizaos/plugin-real"],
      runtimeSurfaceIds: ["@elizaos/plugin-real:service:real"],
      lane: "pr-deterministic",
    });
  });

  test("requires an explicit full id and exact executable boundary signal", () => {
    const action = { kind: "action" as const, name: "SEND_MESSAGE" };
    const actionId = "@elizaos/plugin-test:action:send_message";
    const actionScenario = (body: string, id = actionId): string => `
      export default {
        id: 'send-message',
        lane: 'pr-deterministic',
        runtimeSurfaceIds: ['${id}'],
        finalChecks() { ${body} },
      };
    `;
    const serviceId = "@elizaos/plugin-test:service:notesservice";
    const nestedServiceScenario = (predicate: string): string => `
      export default scenario({
        id: 'notes-service',
        lane: 'pr-deterministic',
        requires: { plugins: ['@elizaos/plugin-test'] },
        runtimeSurfaceIds: ['${serviceId}'],
        finalChecks: [{ type: 'custom', predicate: ${predicate} }],
      });
    `;
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario("// actionName: 'SEND_MESSAGE'"),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "service", name: "NotesService" },
        nestedServiceScenario(
          `(ctx) => ctx.runtime.getService('NotesService') ? undefined : 'missing'`,
        ),
        serviceId,
      ),
    ).toBe(true);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "service", name: "NotesService" },
        `export default scenario({
          id: 'seed-decoy', lane: 'pr-deterministic',
          runtimeSurfaceIds: ['${serviceId}'],
          seed: { predicate: () => expect(runtime.getService('NotesService')) },
          finalChecks: [],
        });`,
        serviceId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "service", name: "NotesService" },
        nestedServiceScenario(
          `() => expect(runtime.getService(OtherService /* 'NotesService' */))`,
        ),
        serviceId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        `export default scenario({
          id: 'structured-action', lane: 'pr-deterministic',
          runtimeSurfaceIds: ['${actionId}'],
          turns: [{
            actionName: 'SEND_MESSAGE',
            assertTurn: (execution) => execution.actionsCalled.length ? undefined : 'missing',
          }],
        });`,
        actionId,
      ),
    ).toBe(true);
    expect(
      isExecutableBoundaryEvidence(
        action,
        `export default scenario({
          id: 'structured-action-decoy', lane: 'pr-deterministic',
          runtimeSurfaceIds: ['${actionId}'],
          seed: { actionName: 'SEND_MESSAGE', assertTurn: () => undefined },
          turns: [{ actionName: 'SEND_MESSAGE', assertTurn: false }],
        });`,
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario("const fixture = { actionName: 'SEND_MESSAGE' };"),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "route", name: "GET /api/messages" },
        "test('runtime-surface:@elizaos/cloud-api:route:get-/api/messages', () => { const routeFixture = '/api/messages'; });",
        "@elizaos/cloud-api:route:get-/api/messages",
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario(
          "assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE' });",
        ),
        actionId,
      ),
    ).toBe(true);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "route", name: "GET /api/messages" },
        "test('runtime-surface:@elizaos/cloud-api:route:get-/api/messages', async () => { expect(await request.get('/api/messages')).toBeDefined(); });",
        "@elizaos/cloud-api:route:get-/api/messages",
      ),
    ).toBe(true);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario(
          "const payload = `assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE' })`;",
        ),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario(
          "function unused() { assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE' }); }",
        ),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "route", name: "GET /api/messages" },
        "test('runtime-surface:@elizaos/cloud-api:route:get-/api/messages', () => { request.get('/api/messages'); expect(true).toBe(true); });",
        "@elizaos/cloud-api:route:get-/api/messages",
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        { kind: "route", name: "GET /api/messages" },
        "test('runtime-surface:@elizaos/cloud-api:route:get-/api/messages', () => { expect(request.get('/wrong', { note: '/api/messages' })).toBeDefined(); });",
        "@elizaos/cloud-api:route:get-/api/messages",
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario(
          "assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE_LONG' });",
        ),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        actionScenario(
          "assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE' });",
          `${actionId}:decoy`,
        ),
        actionId,
      ),
    ).toBe(false);
    expect(
      isExecutableBoundaryEvidence(
        action,
        `
          test('runtime-surface:${actionId}', () => { expect(true).toBe(true); });
          test('unrelated', () => { assertTurn({ type: 'actionCalled', actionName: 'SEND_MESSAGE' }); });
        `,
        actionId,
      ),
    ).toBe(false);
  });

  test("keeps canonical ids stable when implementation files move", () => {
    const first = runtimeSurfaceId({
      kind: "action",
      name: "SEND_MESSAGE",
      package: { packageName: "@elizaos/plugin-test" },
    });
    const second = runtimeSurfaceId({
      kind: "action",
      name: "SEND_MESSAGE",
      package: { packageName: "@elizaos/plugin-test" },
    });
    expect(first).toBe("@elizaos/plugin-test:action:send_message");
    expect(second).toBe(first);
    expect(
      runtimeSurfaceId({
        kind: "scheduled-worker",
        name: "* * * * *",
        package: { packageName: "@elizaos/cloud-api" },
      }),
    ).toBe("@elizaos/cloud-api:scheduled-worker:star-star-star-star-star");
  });

  test("extracts queue and cron bindings from JSONC and TOML syntax", () => {
    expect(
      workerBindingsFromSource(
        "wrangler.jsonc",
        `{
          // production bindings
          "queues": {
            "producers": [{ "binding": "OUTBOUND", "queue": "outbound-jobs" }],
            "consumers": [{ "queue": "inbound-jobs" }],
          },
          "triggers": { "crons": ["*/5 * * * *"] },
        }`,
      ),
    ).toEqual([
      { kind: "queue", name: "OUTBOUND" },
      { kind: "queue", name: "inbound-jobs" },
      { kind: "scheduled-worker", name: "*/5 * * * *" },
    ]);
    expect(
      workerBindingsFromSource(
        "wrangler.toml",
        `[[queues.producers]]
binding = "OUTBOUND"
queue = "outbound-jobs"

[[queues.consumers]]
queue = "inbound-jobs"

[triggers]
crons = ["0 * * * *", "30 * * * *"]
`,
      ),
    ).toEqual([
      { kind: "queue", name: "OUTBOUND" },
      { kind: "queue", name: "inbound-jobs" },
      { kind: "scheduled-worker", name: "0 * * * *" },
      { kind: "scheduled-worker", name: "30 * * * *" },
    ]);
  });

  test("uses package exports and import reachability instead of scanning dead files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "surface-entrypoints-"));
    try {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          exports: { ".": "./index.ts", "./entry": "./dist/entry.js" },
          bin: { fixture: "./src/bin.ts" },
        }),
      );
      mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "index.ts"),
        "export * from './runtime.ts';\n",
      );
      writeFileSync(
        path.join(root, "runtime.ts"),
        "export const live = true;\n",
      );
      writeFileSync(path.join(root, "dead.ts"), "export const dead = true;\n");
      writeFileSync(
        path.join(root, "src", "entry.ts"),
        "export const entry = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "bin.ts"),
        "export const bin = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "plugin.ts"),
        "export const deadPlugin = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "edge.ts"),
        "export const deadEdge = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "index.ts"),
        "export const deadSourceIndex = true;\n",
      );
      expect(packageEntryPoints(root)).toContain(path.join(root, "index.ts"));
      expect(packageEntryPoints(root)).toContain(
        path.join(root, "src", "entry.ts"),
      );
      expect(packageEntryPoints(root)).toContain(
        path.join(root, "src", "bin.ts"),
      );
      expect(packageEntryPoints(root)).not.toContain(
        path.join(root, "src", "plugin.ts"),
      );
      expect(packageEntryPoints(root)).not.toContain(
        path.join(root, "src", "edge.ts"),
      );
      expect(packageEntryPoints(root)).not.toContain(
        path.join(root, "src", "index.ts"),
      );
      expect(reachableProductionFiles(root)).toEqual(
        expect.arrayContaining([
          path.join(root, "index.ts"),
          path.join(root, "runtime.ts"),
        ]),
      );
      expect(reachableProductionFiles(root)).not.toContain(
        path.join(root, "dead.ts"),
      );
      expect(reachableProductionFiles(root)).not.toContain(
        path.join(root, "src", "plugin.ts"),
      );
      expect(reachableProductionFiles(root)).not.toContain(
        path.join(root, "src", "edge.ts"),
      );
      expect(reachableProductionFiles(root)).not.toContain(
        path.join(root, "src", "index.ts"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("includes only manifest-exported platform entrypoints", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "surface-platform-entrypoints-"),
    );
    try {
      mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@elizaos/platform-fixture",
          exports: {
            ".": {
              browser: "./src/index.browser.ts",
              node: "./src/index.node.ts",
              default: "./src/index.ts",
            },
          },
        }),
      );
      for (const file of ["index.browser.ts", "index.node.ts", "index.ts"]) {
        writeFileSync(
          path.join(root, "src", file),
          `export const platform = ${JSON.stringify(file)};\n`,
        );
      }
      writeFileSync(
        path.join(root, "index.ts"),
        "export const rootDecoy = true;\n",
      );
      expect(packageEntryPoints(root)).toEqual([
        path.join(root, "src", "index.browser.ts"),
        path.join(root, "src", "index.node.ts"),
        path.join(root, "src", "index.ts"),
      ]);
      expect(reachableProductionFiles(root)).not.toContain(
        path.join(root, "index.ts"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not collapse arbitrary dist paths onto index decoys", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "surface-dist-decoy-"));
    try {
      mkdirSync(path.join(root, "src"));
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          exports: {
            ".": "./dist/platform/index.js",
            "./edge": "./dist/edge/index.edge.js",
          },
        }),
      );
      writeFileSync(
        path.join(root, "index.ts"),
        "export const decoy = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "index.ts"),
        "export const sourceDecoy = true;\n",
      );
      writeFileSync(
        path.join(root, "src", "index.edge.ts"),
        "export const edge = true;\n",
      );
      expect(packageEntryPoints(root)).toEqual([
        path.join(root, "src", "index.edge.ts"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses generated Cloud router authority and excludes unserved route files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "surface-cloud-routes-"));
    try {
      mkdirSync(path.join(root, "src", "api", "served"), { recursive: true });
      mkdirSync(path.join(root, "src", "api", "dead"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "_router.generated.ts"),
        "import route from '../src/api/served/route';\nexport default route;\n",
      );
      writeFileSync(
        path.join(root, "src", "api", "served", "route.ts"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(root, "src", "api", "dead", "route.ts"),
        "export default {};\n",
      );
      expect(servedCloudRouteFiles(root)).toEqual([
        path.join(root, "src", "api", "served", "route.ts"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports duplicate, artifact-free, and mock-owner coverage findings", () => {
    const badCovered = row("covered", "covered", { boundarySignals: [] });
    const coveredWithoutMockOwner = row("covered-without-mock", "covered", {
      externalServiceDependencies: [
        { id: "external-api", protocol: "External HTTP API" },
      ],
      mockDependencies: [
        {
          serviceId: "external-api",
          availability: "missing",
          owner: null,
          source: null,
          reason: "No resettable production-client mock is registered.",
        },
      ],
      dependencyDisposition: "mock-missing",
    });
    const result = inspectRuntimeSurfaceHealth(
      inventory([
        badCovered,
        coveredWithoutMockOwner,
        row("duplicate", "uncovered"),
        row("duplicate", "uncovered"),
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.invalidCoverage).toContain("covered");
    expect(result.coveredWithoutMockOwner).toContain("covered-without-mock");
    expect(result.duplicateRows).toContain("duplicate");
  });

  test("diffs only explicit package scopes instead of freezing the repository", () => {
    const previous = inventory([
      row("owned:action:removed", "uncovered", {
        packageName: "@elizaos/owned",
      }),
      row("other:action:ignored", "uncovered", {
        packageName: "@elizaos/other",
      }),
    ]);
    const current = inventory([
      row("owned:action:added", "uncovered", {
        packageName: "@elizaos/owned",
      }),
      row("other:action:changed", "covered", {
        packageName: "@elizaos/other",
      }),
    ]);
    expect(
      compareRuntimeSurfaceInventories(current, previous, ["@elizaos/owned"]),
    ).toEqual({
      packages: ["@elizaos/owned"],
      added: ["owned:action:added"],
      removed: ["owned:action:removed"],
      changed: [],
    });
    expect(() =>
      compareRuntimeSurfaceInventories(current, previous, []),
    ).toThrow(/explicit package scope/);
  });
});

import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const scenarioGuidanceSlug = "scenario-guidance";
const registrySkillSlug = "registry-weather";
const searchSkillsText = "Search skills for weather";
const registrySearchText = "Find registry-backed skills";
const registryDetailsText = "registry-weather details skill";
const registryInstallText = 'Install skill "registry-weather"';
const registryDisableText = 'Disable skill "registry-weather"';
const useGuidanceText = "Run USE_SKILL for scenario-guidance in guidance mode";
const syncCatalogText = "Update the skill catalog";
const uninstallPromptText = 'Uninstall skill "registry-weather"';
const uninstallConfirmText = 'yes, run skill uninstall for "registry-weather"';

const scenarioGuidanceSkillMd = [
  "---",
  "name: scenario-guidance",
  "description: Deterministic guidance skill for scenario-runner coverage",
  "metadata:",
  "  version: 1.0.0",
  "---",
  "Use this deterministic guidance whenever the scenario asks for seeded skill instructions.",
  "Return the phrase scenario-guidance-ok when confirming the guidance was loaded.",
  "",
].join("\n");

const registryWeatherSkillMd = [
  "---",
  "name: registry-weather",
  "description: Registry-backed deterministic weather guidance",
  "metadata:",
  "  version: 1.0.0",
  "---",
  "Use the deterministic registry weather skill to report stable, fake weather.",
  "Return the phrase registry-weather-ok when confirming the installed skill works.",
  "",
].join("\n");

const registrySearchResult = {
  score: 0.99,
  slug: registrySkillSlug,
  displayName: "Registry Weather",
  summary: "Deterministic registry weather skill for e2e coverage.",
  version: "1.0.0",
  updatedAt: 1_725_000_000_000,
};

const registryCatalogEntry = {
  slug: registrySkillSlug,
  displayName: "Registry Weather",
  summary: "Deterministic registry weather skill for e2e coverage.",
  version: "1.0.0",
  tags: { domain: "testing" },
  stats: { downloads: 42, stars: 7 },
  updatedAt: 1_725_000_000_000,
};

const registryDetails = {
  skill: {
    slug: registrySkillSlug,
    displayName: "Registry Weather",
    summary: "Deterministic registry weather skill for e2e coverage.",
    tags: { domain: "testing" },
    stats: { downloads: 42, stars: 7, versions: 1 },
    createdAt: 1_724_000_000_000,
    updatedAt: 1_725_000_000_000,
  },
  latestVersion: {
    version: "1.0.0",
    createdAt: 1_725_000_000_000,
    changelog: "Initial deterministic test package.",
  },
  owner: {
    handle: "scenario",
    displayName: "Scenario Runner",
  },
};

const strictAgentSkillRoutes = [
  {
    actionName: "SKILL",
    args: { action: "search" },
    contextIds: ["knowledge"],
    input: searchSkillsText,
    messageToUser: `Found ${registrySkillSlug}.`,
  },
  {
    actionName: "SKILL_SEARCH",
    args: { action: "search" },
    contextIds: ["knowledge"],
    input: registrySearchText,
    messageToUser: `Found ${registrySkillSlug}.`,
  },
  {
    actionName: "SKILL_DETAILS",
    args: { action: "details" },
    contextIds: ["knowledge"],
    input: registryDetailsText,
    messageToUser: "Registry Weather details.",
  },
  {
    actionName: "SKILL_INSTALL",
    args: { action: "install" },
    contextIds: ["settings"],
    input: registryInstallText,
    messageToUser: `Skill ${registrySkillSlug} installed successfully.`,
  },
  {
    actionName: "SKILL_TOGGLE",
    args: { action: "toggle" },
    contextIds: ["settings"],
    input: registryDisableText,
    messageToUser: `Skill ${registrySkillSlug} has been disabled.`,
  },
  {
    actionName: "USE_SKILL",
    args: { slug: scenarioGuidanceSlug, mode: "guidance" },
    contextIds: ["knowledge"],
    input: useGuidanceText,
    messageToUser: "scenario-guidance-ok",
  },
  {
    actionName: "SKILL_SYNC",
    args: { action: "sync" },
    contextIds: ["settings"],
    input: syncCatalogText,
    messageToUser: "Skill catalog synced successfully.",
  },
  {
    actionName: "SKILL_UNINSTALL",
    args: { action: "uninstall" },
    contextIds: ["settings"],
    input: uninstallPromptText,
    messageToUser: `Reply "yes" to confirm uninstalling ${registrySkillSlug}.`,
  },
  {
    actionName: "SKILL_UNINSTALL",
    args: { action: "uninstall" },
    contextIds: ["settings"],
    input: uninstallConfirmText,
    messageToUser: `Skill ${registrySkillSlug} has been uninstalled.`,
  },
];

let restoreFetch: (() => void) | null = null;
const registryFetchCalls: string[] = [];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionParameters(action: CapturedAction): JsonRecord {
  return isRecord(action.parameters) ? action.parameters : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function expectSuccess(action: CapturedAction): string | undefined {
  return action.result?.success === true
    ? undefined
    : `expected ActionResult.success=true, saw ${stableStringify(action.result)}`;
}

function expectAction(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters?: JsonRecord;
    resultFields: JsonRecord;
  },
): string | undefined {
  const action = firstAction(execution, expected.actionName);
  if (typeof action === "string") return action;
  return (
    (expected.parameters
      ? expectActionParameters(action, expected.parameters)
      : undefined) ??
    expectSuccess(action) ??
    (() => {
      for (const [path, expectedValue] of Object.entries(
        expected.resultFields,
      )) {
        const actual = readPath(action.result, path);
        const failure = expectEqual(
          actual,
          expectedValue,
          `${expected.actionName} result.${path}`,
        );
        if (failure) return failure;
      }
      return undefined;
    })()
  );
}

function expectActionParameters(
  action: CapturedAction,
  expectedParameters: JsonRecord,
): string | undefined {
  const actual = actionParameters(action);
  const directFailure = expectEqual(
    actual,
    expectedParameters,
    `${action.actionName} handler options`,
  );
  if (!directFailure) return undefined;
  const nested = isRecord(actual.parameters) ? actual.parameters : null;
  const nestedFailure = nested
    ? expectEqual(
        nested,
        expectedParameters,
        `${action.actionName} nested handler parameters`,
      )
    : directFailure;
  return nestedFailure
    ? `expected ${action.actionName} handler parameters to include ${stableStringify(expectedParameters)}, saw ${stableStringify(actual)}`
    : undefined;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function makeStoredZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const checksum = crc32(data);

    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, data.byteLength);
    writeUint32(localView, 22, data.byteLength);
    writeUint16(localView, 26, nameBytes.byteLength);
    writeUint16(localView, 28, 0);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, data.byteLength);
    writeUint32(centralView, 24, data.byteLength);
    writeUint16(centralView, 28, nameBytes.byteLength);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    localOffset += local.byteLength;
  }

  const centralDirectory = concatBytes(centralChunks);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, centralChunks.length);
  writeUint16(endView, 10, centralChunks.length);
  writeUint32(endView, 12, centralDirectory.byteLength);
  writeUint32(endView, 16, localOffset);
  writeUint16(endView, 20, 0);

  return concatBytes([...localChunks, centralDirectory, end]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installRegistryFetchMock(): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const zipBytes = makeStoredZip({ "SKILL.md": registryWeatherSkillMd });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href);
    if (!url.hostname.includes("clawhub.ai")) {
      return originalFetch(input, init);
    }
    registryFetchCalls.push(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v1/search") {
      return jsonResponse({ results: [registrySearchResult] });
    }
    if (url.pathname === `/api/v1/skills/${registrySkillSlug}`) {
      return jsonResponse(registryDetails);
    }
    if (url.pathname === "/api/v1/skills") {
      return jsonResponse({ items: [registryCatalogEntry] });
    }
    if (url.pathname === "/api/v1/download") {
      return new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = null;
  };
}

async function seedScenarioSkill(service: {
  getStorage: () => {
    saveSkill: (pkg: {
      slug: string;
      files: Map<
        string,
        { path: string; content: string | Uint8Array; isText: boolean }
      >;
    }) => Promise<void>;
  };
  loadSkill: (slug: string) => Promise<unknown>;
  setSkillEnabled: (slug: string, enabled: boolean) => boolean;
}): Promise<void> {
  await service.getStorage().saveSkill({
    slug: scenarioGuidanceSlug,
    files: new Map([
      [
        "SKILL.md",
        { path: "SKILL.md", content: scenarioGuidanceSkillMd, isText: true },
      ],
    ]),
  });
  await service.loadSkill(scenarioGuidanceSlug);
  service.setSkillEnabled(scenarioGuidanceSlug, true);
}

async function finalLedgerCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  restoreFetch?.();

  const calls = ctx.actionsCalled ?? [];
  const names = calls.map((call) => call.actionName);
  const orderFailure = expectEqual(
    names,
    [
      "SKILL",
      "SKILL_SEARCH",
      "SKILL_DETAILS",
      "SKILL_INSTALL",
      "SKILL_TOGGLE",
      "USE_SKILL",
      "SKILL_SYNC",
      "SKILL_UNINSTALL",
      "SKILL_UNINSTALL",
    ],
    "agent-skills action order",
  );
  if (orderFailure) return orderFailure;

  const failed = calls.filter((call) => call.result?.success !== true);
  if (failed.length > 0) {
    return `expected every agent-skills action to succeed, saw ${stableStringify(failed)}`;
  }

  for (const required of [
    "/api/v1/search",
    `/api/v1/skills/${registrySkillSlug}`,
    "/api/v1/download",
    "/api/v1/skills",
  ]) {
    if (!registryFetchCalls.some((call) => call.startsWith(required))) {
      return `expected registry fetch for ${required}, saw ${stableStringify(registryFetchCalls)}`;
    }
  }

  const runtime = ctx.runtime as
    | {
        getService?: (serviceType: string) => unknown;
      }
    | undefined;
  const service = runtime?.getService?.("AGENT_SKILLS_SERVICE") as
    | {
        getLoadedSkill?: (slug: string) => unknown;
        getStorage?: () => {
          hasSkill?: (slug: string) => Promise<boolean>;
          deleteSkill?: (slug: string) => Promise<boolean>;
        };
      }
    | undefined;
  if (service?.getLoadedSkill?.(registrySkillSlug)) {
    return `expected ${registrySkillSlug} to be unloaded after uninstall`;
  }
  if (await service?.getStorage?.().hasSkill?.(registrySkillSlug)) {
    return `expected ${registrySkillSlug} package to be deleted after uninstall`;
  }
  await service?.getStorage?.().deleteSkill?.(scenarioGuidanceSlug);
  return undefined;
}

export default scenario({
  id: "deterministic-agent-skills-actions",
  title: "Deterministic agent-skills action catalog",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "agent-skills"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed local skill and mock ClawHub registry",
      apply: async (ctx) => {
        registryFetchCalls.length = 0;
        installRegistryFetchMock();

        const runtime = ctx.runtime as
          | {
              getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
              getService?: (serviceType: string) => unknown;
            }
          | undefined;
        await runtime?.getServiceLoadPromise?.("AGENT_SKILLS_SERVICE");
        const service = runtime?.getService?.("AGENT_SKILLS_SERVICE") as
          | Parameters<typeof seedScenarioSkill>[0]
          | undefined;
        if (!service) {
          return "AgentSkillsService unavailable";
        }
        await seedScenarioSkill(service);
        registerStrictActionRouteFixtures(
          runtime as RuntimeWithScenarioLlmFixtures,
          strictAgentSkillRoutes,
        );
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic Agent Skills",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "parent skill action routes search op",
      text: searchSkillsText,
      responseIncludesAny: [registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL",
          parameters: { action: "search" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "search",
            "data.results.0.slug": registrySkillSlug,
            "values.resultCount": 1,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill search action hits registry",
      text: registrySearchText,
      responseIncludesAny: [registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_SEARCH",
          parameters: { action: "search" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "search",
            "data.results.0.slug": registrySkillSlug,
            "values.resultCount": 1,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill details action reads registry details",
      text: registryDetailsText,
      responseIncludesAny: ["Registry Weather"],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_DETAILS",
          parameters: { action: "details" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "details",
            "data.details.skill.slug": registrySkillSlug,
            "data.isInstalled": false,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill install action downloads and scans package",
      text: registryInstallText,
      responseIncludesAny: ["installed successfully", registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_INSTALL",
          parameters: { action: "install" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "install",
            "data.slug": registrySkillSlug,
            "data.scanStatus": "clean",
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill toggle action disables installed package",
      text: registryDisableText,
      responseIncludesAny: ["has been disabled", registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_TOGGLE",
          parameters: { action: "toggle" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "toggle",
            "data.slug": registrySkillSlug,
            "data.enabled": false,
          },
        }),
    },
    {
      kind: "message",
      name: "use seeded local guidance skill",
      text: useGuidanceText,
      responseIncludesAny: ["scenario-guidance-ok"],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "USE_SKILL",
          parameters: { slug: scenarioGuidanceSlug, mode: "guidance" },
          resultFields: {
            "data.slug": scenarioGuidanceSlug,
            "data.mode": "guidance",
            "values.activeSkill": scenarioGuidanceSlug,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill sync action refreshes mocked catalog",
      text: syncCatalogText,
      responseIncludesAny: ["Skill catalog synced successfully"],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_SYNC",
          parameters: { action: "sync" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "sync",
            // Boot-time catalog sync is disabled for scenario runs (hermetic,
            // no network), so this is the FIRST catalog fetch: it discovers the
            // single mocked registry skill from an empty cache → added: 1.
            "data.updated": 1,
            "data.added": 1,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill uninstall action asks for confirmation",
      text: uninstallPromptText,
      responseIncludesAny: ['Reply "yes" to confirm', registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_UNINSTALL",
          parameters: { action: "uninstall" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "uninstall",
            "data.awaitingUserInput": true,
            "data.slug": registrySkillSlug,
          },
        }),
    },
    {
      kind: "message",
      name: "virtual skill uninstall action deletes confirmed package",
      text: uninstallConfirmText,
      responseIncludesAny: ["has been uninstalled", registrySkillSlug],
      assertTurn: (execution) =>
        expectAction(execution, {
          actionName: "SKILL_UNINSTALL",
          parameters: { action: "uninstall" },
          resultFields: {
            "data.actionName": "SKILL",
            "data.op": "uninstall",
            "data.slug": registrySkillSlug,
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SKILL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_SEARCH",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_DETAILS",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_INSTALL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_TOGGLE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "USE_SKILL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_SYNC",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "SKILL_UNINSTALL",
      status: "success",
      minCount: 2,
    },
    {
      type: "selectedActionArguments",
      actionName: [
        "SKILL",
        "SKILL_SEARCH",
        "SKILL_DETAILS",
        "SKILL_INSTALL",
        "SKILL_TOGGLE",
        "USE_SKILL",
        "SKILL_SYNC",
        "SKILL_UNINSTALL",
      ],
      includesAll: [
        /registry-weather/,
        /scenario-guidance/,
        /guidance/,
        /search/,
      ],
    },
    {
      type: "custom",
      name: "agent-skills action ledger, registry fetches, and storage side effects are exact",
      predicate: finalLedgerCheck,
    },
  ],
});

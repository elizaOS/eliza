import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_SAMANTHA_SCENARIOS,
  LIFEOPS_SAMANTHA_SUPPORTED_PROVIDERS,
  type LifeOpsSamanthaProvider,
} from "../fixtures/lifeops-samantha.ts";
import {
  type MockEnvironmentName,
  startMocks,
} from "../scripts/start-mocks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const MOCKOON_ENV_PATH = path.resolve(
  PROJECT_ROOT,
  "test/mocks/environments/lifeops-samantha.json",
);

interface MockoonRoute {
  endpoint: string;
  method: string;
  responses?: { body?: string; statusCode?: number }[];
}

const API_EXAMPLE_ENV_BY_PROVIDER: Partial<
  Record<LifeOpsSamanthaProvider, MockEnvironmentName>
> = {
  "lifeops-local": "lifeops-samantha",
  google: "google",
  github: "github",
  bluebubbles: "bluebubbles",
  signal: "signal",
  "browser-workspace": "browser-workspace",
};

function apiExampleHeaders(
  provider: LifeOpsSamanthaProvider,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider === "bluebubbles") {
    headers.Authorization = "Bearer mock-bluebubbles-password";
  }
  if (provider === "browser-workspace") {
    headers.Authorization = "Bearer mock-browser-workspace-token";
  }
  return headers;
}

function readLifeOpsMockoonEnvironment(): { routes: MockoonRoute[] } {
  return JSON.parse(fs.readFileSync(MOCKOON_ENV_PATH, "utf8")) as {
    routes: MockoonRoute[];
  };
}

describe("LifeOps Samantha mock scenario catalog", () => {
  it("covers the seven assistant interaction moves with useful fixtures", () => {
    expect(LIFEOPS_SAMANTHA_SCENARIOS).toHaveLength(7);
    expect(LIFEOPS_SAMANTHA_SCENARIOS.map((scenario) => scenario.move)).toEqual(
      [1, 2, 3, 4, 5, 6, 7],
    );

    for (const scenario of LIFEOPS_SAMANTHA_SCENARIOS) {
      expect(scenario.id).toMatch(/^move-0[1-7]-/);
      expect(scenario.sceneInteraction.length).toBeGreaterThan(80);
      expect(scenario.userRequest.length).toBeGreaterThan(40);
      expect(scenario.mockRecords.length).toBeGreaterThan(0);
      expect(scenario.apiExamples.length).toBeGreaterThan(0);
      expect(scenario.expectedWorkflow.length).toBeGreaterThanOrEqual(3);
      expect(scenario.expectedAssertions.length).toBeGreaterThanOrEqual(3);
      expect(scenario.safetyGates.length).toBeGreaterThan(0);
      expect(scenario.edgeCases.length).toBeGreaterThan(0);
    }
  });

  it("includes common, edge, organizational, multi-hop, and long-running cases", () => {
    const useCases = new Set(
      LIFEOPS_SAMANTHA_SCENARIOS.flatMap((scenario) => scenario.useCases),
    );

    expect(useCases).toEqual(
      new Set([
        "common",
        "edge",
        "organizational",
        "multi-hop",
        "long-running",
      ]),
    );

    const multiHop = LIFEOPS_SAMANTHA_SCENARIOS.find(
      (scenario) =>
        scenario.useCases.includes("multi-hop") &&
        scenario.useCases.includes("long-running"),
    );
    expect(multiHop?.providers).toEqual(
      expect.arrayContaining(["google", "github", "bluebubbles"]),
    );
    expect(
      multiHop?.apiExamples.some((example) => example.method === "GET"),
    ).toBe(true);
    expect(
      multiHop?.apiExamples.some((example) => example.method === "POST"),
    ).toBe(true);
  });

  it("keeps API examples aligned to supported real mock providers", () => {
    const supportedProviders = new Set<LifeOpsSamanthaProvider>(
      LIFEOPS_SAMANTHA_SUPPORTED_PROVIDERS,
    );

    for (const scenario of LIFEOPS_SAMANTHA_SCENARIOS) {
      for (const provider of scenario.providers) {
        expect(supportedProviders.has(provider)).toBe(true);
      }
      for (const example of scenario.apiExamples) {
        expect(supportedProviders.has(example.provider)).toBe(true);
        expect(example.path).toMatch(/^\//);
        expect(example.expectedStatus).toBeGreaterThanOrEqual(200);
        expect(example.expectedStatus).toBeLessThan(600);
        expect(example.responseShape.length).toBeGreaterThan(0);
      }
    }
  });

  it("ships a Mockoon-compatible environment for manual API testing", () => {
    const environment = readLifeOpsMockoonEnvironment();
    const routes = environment.routes.map((route) => ({
      endpoint: route.endpoint,
      method: route.method.toUpperCase(),
    }));

    expect(routes).toEqual(
      expect.arrayContaining([
        { method: "GET", endpoint: "__mock/lifeops/samantha/scenarios" },
        { method: "POST", endpoint: "api/lifeops/intake/utterance" },
        { method: "POST", endpoint: "api/lifeops/memory/preferences" },
        { method: "POST", endpoint: "api/lifeops/context/scan" },
        { method: "POST", endpoint: "api/lifeops/email/curation-preview" },
        { method: "POST", endpoint: "api/lifeops/contacts/resolve" },
        { method: "POST", endpoint: "api/lifeops/documents/proofread" },
        { method: "POST", endpoint: "__mock/lifeops/samantha/tasks" },
        { method: "GET", endpoint: "__mock/lifeops/samantha/tasks/:id" },
        {
          method: "POST",
          endpoint: "__mock/lifeops/samantha/tasks/:id/advance",
        },
        {
          method: "POST",
          endpoint: "api/lifeops/context/scan/provider-down",
        },
        {
          method: "POST",
          endpoint: "api/lifeops/contacts/resolve/ambiguous",
        },
        {
          method: "POST",
          endpoint: "api/lifeops/email/curation-preview/too-broad",
        },
      ]),
    );

    const catalogRoute = environment.routes.find(
      (route) => route.endpoint === "__mock/lifeops/samantha/scenarios",
    );
    const catalogBody = JSON.parse(
      catalogRoute?.responses?.[0]?.body ?? "{}",
    ) as { scenarioCount?: number; scenarios?: { id: string }[] };

    expect(catalogBody.scenarioCount).toBe(LIFEOPS_SAMANTHA_SCENARIOS.length);
    expect(catalogBody.scenarios?.map((scenario) => scenario.id)).toEqual(
      LIFEOPS_SAMANTHA_SCENARIOS.map((scenario) => scenario.id),
    );
  });

  it("starts the standalone LifeOps Mockoon API for manual-style testing", async () => {
    const mocks = await startMocks({ envs: ["lifeops-samantha"] });
    try {
      expect(mocks.envVars.ELIZA_MOCK_LIFEOPS_SAMANTHA_BASE).toBe(
        mocks.baseUrls["lifeops-samantha"],
      );

      const affectRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/api/lifeops/intake/utterance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "I have not been social in a while, really because...",
          }),
        },
      );
      expect(affectRes.status).toBe(200);
      await expect(affectRes.json()).resolves.toMatchObject({
        affect: { observation: "hesitation" },
        persistence: { allowed: false },
      });

      const providerDownRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/api/lifeops/context/scan/provider-down`,
        { method: "POST" },
      );
      expect(providerDownRes.status).toBe(503);
      await expect(providerDownRes.json()).resolves.toMatchObject({
        error: "provider_unavailable",
        provider: "gmail",
      });
    } finally {
      await mocks.stop();
    }
  });

  it("serves the scenario catalog only from the scenario mock", async () => {
    const mocks = await startMocks({ envs: ["lifeops-samantha"] });
    try {
      const catalogRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/__mock/lifeops/samantha/scenarios`,
      );
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as {
        scenarioCount: number;
        scenarios: { id: string; apiExampleCount: number }[];
      };
      expect(catalog.scenarioCount).toBe(7);
      expect(catalog.scenarios[0]?.apiExampleCount).toBeGreaterThan(0);

      const detailRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/__mock/lifeops/samantha/scenarios/move-07-proactive-multihop-and-long-running`,
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        scenario: { useCases: string[]; expectedWorkflow: string[] };
      };
      expect(detail.scenario.useCases).toContain("long-running");
      expect(detail.scenario.expectedWorkflow.join(" ")).toContain(
        "Resolve X from Y",
      );

      const taskCreateRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/__mock/lifeops/samantha/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scenarioId: "move-07-proactive-multihop-and-long-running",
          }),
        },
      );
      expect(taskCreateRes.status).toBe(202);
      const taskCreate = (await taskCreateRes.json()) as {
        taskId: string;
        pollUrl: string;
        task: { status: string; percentComplete: number };
      };
      expect(taskCreate.task.status).toBe("queued");
      expect(taskCreate.pollUrl).toContain(taskCreate.taskId);

      const firstPoll = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}${taskCreate.pollUrl}`,
      );
      const secondPoll = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}${taskCreate.pollUrl}`,
      );
      expect(firstPoll.status).toBe(200);
      expect(secondPoll.status).toBe(200);
      const firstTask = (
        (await firstPoll.json()) as {
          task: { status: string; percentComplete: number };
        }
      ).task;
      const secondTask = (
        (await secondPoll.json()) as {
          task: { status: string; percentComplete: number };
        }
      ).task;

      expect(firstTask.status).toBe("queued");
      expect(secondTask).toEqual(firstTask);

      const advanceRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}${taskCreate.pollUrl}/advance`,
        { method: "POST" },
      );
      expect(advanceRes.status).toBe(200);
      const advancedTask = (
        (await advanceRes.json()) as {
          task: { status: string; percentComplete: number };
        }
      ).task;
      expect(advancedTask.status).toBe("running");
      expect(advancedTask.percentComplete).toBeGreaterThan(
        firstTask.percentComplete,
      );

      const invalidTaskRes = await fetch(
        `${mocks.baseUrls["lifeops-samantha"]}/__mock/lifeops/samantha/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: "move-01-intake-voice-affect" }),
        },
      );
      expect(invalidTaskRes.status).toBe(422);

      expect(mocks.requestLedger()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lifeopsSamantha: expect.objectContaining({
              action: "scenarios.list",
            }),
          }),
          expect.objectContaining({
            lifeopsSamantha: expect.objectContaining({
              action: "tasks.create",
              status: "queued",
            }),
          }),
          expect.objectContaining({
            lifeopsSamantha: expect.objectContaining({
              action: "tasks.get",
              status: "queued",
            }),
          }),
          expect.objectContaining({
            lifeopsSamantha: expect.objectContaining({
              action: "tasks.advance",
              status: "running",
            }),
          }),
          expect.objectContaining({
            lifeopsSamantha: expect.objectContaining({
              action: "tasks.create.rejected",
              status: "not_long_running",
            }),
          }),
        ]),
      );
    } finally {
      await mocks.stop();
    }

    const providerMocks = await startMocks({ envs: ["google"] });
    try {
      const providerCatalogRes = await fetch(
        `${providerMocks.baseUrls.google}/__mock/lifeops/samantha/scenarios`,
      );
      expect(providerCatalogRes.status).toBe(404);
    } finally {
      await providerMocks.stop();
    }
  });

  it("executes every advertised API example against a real mock", async () => {
    const mocks = await startMocks({
      envs: [
        "lifeops-samantha",
        "google",
        "github",
        "browser-workspace",
        "bluebubbles",
        "signal",
      ],
    });
    try {
      for (const scenario of LIFEOPS_SAMANTHA_SCENARIOS) {
        for (const example of scenario.apiExamples) {
          const environment = API_EXAMPLE_ENV_BY_PROVIDER[example.provider];
          expect(
            environment,
            `${scenario.id}: ${example.name} has no executable mock mapping`,
          ).toBeDefined();
          if (!environment) continue;

          mocks.clearRequestLedger();
          const res = await fetch(
            `${mocks.baseUrls[environment]}${example.path}${example.query ?? ""}`,
            {
              method: example.method,
              headers: apiExampleHeaders(example.provider),
              ...(example.requestBody
                ? { body: JSON.stringify(example.requestBody) }
                : {}),
            },
          );
          expect(res.status, `${scenario.id}: ${example.name}`).toBe(
            example.expectedStatus,
          );
          await res.json();

          const ledgerEntry = mocks
            .requestLedger()
            .find((entry) => entry.path === example.path);
          expect(ledgerEntry, `${scenario.id}: ${example.name}`).toBeDefined();
          if (!example.expectedLedgerAction) continue;

          const actualAction =
            ledgerEntry?.gmail?.action ??
            ledgerEntry?.calendar?.action ??
            ledgerEntry?.github?.action ??
            ledgerEntry?.browserWorkspace?.action ??
            ledgerEntry?.bluebubbles?.action ??
            ledgerEntry?.signal?.action;
          expect(actualAction, `${scenario.id}: ${example.name}`).toBe(
            example.expectedLedgerAction,
          );
        }
      }
    } finally {
      await mocks.stop();
    }
  });

  it("keeps the signed packet hash aligned with the Gmail attachment bytes", async () => {
    const scenario = LIFEOPS_SAMANTHA_SCENARIOS.find(
      (candidate) =>
        candidate.id === "move-07-proactive-multihop-and-long-running",
    );
    const packetRecord = scenario?.mockRecords.find(
      (record) => record.id === "email-vendor-signed-packet",
    );
    const expectedHash = String(packetRecord?.payload.contentHash).replace(
      /^sha256:/,
      "",
    );

    const mocks = await startMocks({ envs: ["google"] });
    try {
      const res = await fetch(
        `${mocks.baseUrls.google}/gmail/v1/users/me/messages/msg-vendor-packet-signed/attachments/att-vendor-packet-signed-pdf`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: string };
      const actualHash = crypto
        .createHash("sha256")
        .update(Buffer.from(body.data, "base64url"))
        .digest("hex");

      expect(actualHash).toBe(expectedHash);
    } finally {
      await mocks.stop();
    }
  });
});

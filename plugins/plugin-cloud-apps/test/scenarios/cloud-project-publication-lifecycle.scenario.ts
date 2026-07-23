/**
 * Deterministic end-to-end coverage for project publication over a real
 * AgentRuntime, projects.json registry, Cloud SDK, and loopback HTTP transport.
 * This is keyless transport/state evidence, not live-model or live-Cloud proof.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { join } from "node:path";
import type { AppDto, AppFrontendDeploymentDto } from "@elizaos/cloud-sdk";
import {
  getProjectById,
  readProjectRegistry,
  setActiveProject,
  upsertProject,
} from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "../../../../packages/scenario-runner/schema/index.js";
import { scenario } from "../../../../packages/scenario-runner/schema/index.js";
import { cloudAppsPlugin } from "../../src/index.js";

const APP_ID = "22222222-3333-4444-8555-666666666666";
const DEPLOYMENT_ID = "frontend-publication-scenario-1";
const PROJECT_NAME = "Scenario Project";
const DOMAIN_NAME = "scenario.tools";

interface CloudMockCall {
  method: string;
  pathname: string;
  body: unknown;
  authorization: string | null;
  projectBindingAtCall: string | null;
}

interface CloudAppsScenarioRuntime {
  registerPlugin(plugin: typeof cloudAppsPlugin): void | Promise<void>;
  setSetting(key: string, value: string, isSecret?: boolean): void;
}

const cloudCalls: CloudMockCall[] = [];
let cloudServer: http.Server | null = null;
let cloudApp: AppDto;
let publicUrl = "";
let projectId = "";
let stateDir: string | null = null;
let projectDir: string | null = null;
let previousStateDir: string | undefined;
let originalFetch: typeof fetch | null = null;

function initialCloudApp(): AppDto {
  return {
    id: APP_ID,
    name: PROJECT_NAME,
    description: "Published by the deterministic lifecycle scenario",
    slug: "scenario-project",
    organization_id: "org-scenario",
    created_by_user_id: "user-scenario",
    app_url: "https://pending.invalid",
    allowed_origins: ["https://pending.invalid"],
    api_key_id: "api-key-scenario",
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 42,
    total_users: 7,
    total_credits_used: "12.34",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: true,
    inference_markup_percentage: 15,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: "125.00",
    total_platform_revenue: "10.00",
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: false,
    is_approved: true,
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: "2026-07-01T00:00:00.000Z",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    last_used_at: null,
  };
}

function frontendDeployment(): AppFrontendDeploymentDto {
  return {
    id: DEPLOYMENT_ID,
    app_id: APP_ID,
    version: 1,
    status: "active",
    r2_prefix: `app-frontends/org-scenario/${APP_ID}/${DEPLOYMENT_ID}/`,
    content_hash: "a".repeat(64),
    file_count: 1,
    total_bytes: 72,
    error: null,
    created_at: "2026-07-23T12:00:00.000Z",
    activated_at: "2026-07-23T12:00:01.000Z",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCloudAppsScenarioRuntime(
  runtime: unknown,
): runtime is CloudAppsScenarioRuntime {
  return (
    isRecord(runtime) &&
    typeof runtime.registerPlugin === "function" &&
    typeof runtime.setSetting === "function"
  );
}

function responseData(turn: ScenarioTurnExecution): Record<string, unknown> {
  return isRecord(turn.responseBody) && isRecord(turn.responseBody.data)
    ? turn.responseBody.data
    : {};
}

function expectDataFlag(
  key: string,
  expected: unknown,
): (turn: ScenarioTurnExecution) => string | undefined {
  return (turn) => {
    const data = responseData(turn);
    return data[key] === expected
      ? undefined
      : `expected response data.${key}=${String(expected)}, saw ${String(data[key])}`;
  };
}

function countCalls(method: string, pathname: string): number {
  return cloudCalls.filter(
    (call) => call.method === method && call.pathname === pathname,
  ).length;
}

function callsFor(method: string, pathname: string): CloudMockCall[] {
  return cloudCalls.filter(
    (call) => call.method === method && call.pathname === pathname,
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : null;
}

function patchCloudApp(body: unknown): void {
  if (!isRecord(body)) {
    throw new Error("Cloud PATCH body must be an object");
  }
  const next = { ...cloudApp };
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      throw new Error("Cloud PATCH name must be a string");
    }
    next.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new Error("Cloud PATCH description must be a string");
    }
    next.description = body.description;
  }
  if (body.app_url !== undefined) {
    if (typeof body.app_url !== "string") {
      throw new Error("Cloud PATCH app_url must be a string");
    }
    next.app_url = body.app_url;
  }
  if (body.allowed_origins !== undefined) {
    if (
      !Array.isArray(body.allowed_origins) ||
      !body.allowed_origins.every((origin) => typeof origin === "string")
    ) {
      throw new Error("Cloud PATCH allowed_origins must be strings");
    }
    next.allowed_origins = body.allowed_origins;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      throw new Error("Cloud PATCH is_active must be a boolean");
    }
    next.is_active = body.is_active;
  }
  next.updated_at = "2026-07-23T12:00:02.000Z";
  cloudApp = next;
}

async function handleCloudRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  const body = method === "GET" ? null : await readBody(req);
  cloudCalls.push({
    method,
    pathname: url.pathname,
    body,
    authorization: req.headers.authorization ?? null,
    projectBindingAtCall:
      projectId.length > 0
        ? (getProjectById(projectId)?.cloudAppId ?? null)
        : null,
  });

  if (method === "GET" && url.pathname === "/published/scenario-project") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Scenario Project</title>");
    return;
  }

  if (method === "POST" && url.pathname === "/api/v1/apps") {
    json(res, 201, {
      success: true,
      app: cloudApp,
      apiKey: "eliza_scenario_created_once",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/apps") {
    json(res, 200, { success: true, apps: [cloudApp] });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}`) {
    json(res, 200, { success: true, app: cloudApp });
    return;
  }

  if (method === "PATCH" && url.pathname === `/api/v1/apps/${APP_ID}`) {
    patchCloudApp(body);
    json(res, 200, { success: true, app: cloudApp });
    return;
  }

  if (method === "POST" && url.pathname === `/api/v1/apps/${APP_ID}/frontend`) {
    json(res, 201, {
      success: true,
      deployment: frontendDeployment(),
      public_url: publicUrl,
    });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}/frontend`) {
    json(res, 200, {
      success: true,
      active_deployment_id: DEPLOYMENT_ID,
      public_url: publicUrl,
      deployments: [frontendDeployment()],
    });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}/analytics`) {
    json(res, 200, {
      success: true,
      analytics: [
        {
          period_start: "2026-07-23T00:00:00.000Z",
          total_requests: 42,
          unique_users: 7,
          new_users: 2,
          total_cost: "12.34",
        },
      ],
      totalStats: {
        totalRequests: 42,
        totalUsers: 7,
        totalCreditsUsed: "12.34",
      },
      period: {
        type: "daily",
        start: "2026-06-23T00:00:00.000Z",
        end: "2026-07-23T00:00:00.000Z",
      },
    });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}/earnings`) {
    json(res, 200, {
      success: true,
      earnings: {
        summary: {
          withdrawableBalance: 75,
          pendingBalance: 10,
          totalLifetimeEarnings: 125,
          totalWithdrawn: 40,
          payoutThreshold: 25,
        },
      },
      monetization: { enabled: true },
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/v1/domains/search") {
    if (!isRecord(body) || body.query !== "scenario" || body.limit !== 2) {
      json(res, 400, { success: false, error: "invalid search request" });
      return;
    }
    json(res, 200, {
      success: true,
      query: "scenario",
      candidates: [
        {
          domain: DOMAIN_NAME,
          available: true,
          currency: "USD",
          years: 1,
          price: {
            wholesaleUsdCents: 1000,
            marginUsdCents: 360,
            totalUsdCents: 1360,
            marginBps: 3600,
          },
        },
        {
          domain: "scenario.app",
          available: false,
          reason: "domain_unavailable",
          currency: "USD",
          years: 1,
          price: null,
        },
      ],
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/domains") {
    json(res, 200, {
      success: true,
      domains: [
        {
          id: "domain-scenario-1",
          domain: DOMAIN_NAME,
          registrar: "cloudflare",
          status: "active",
          verified: true,
          sslStatus: "active",
          expiresAt: "2027-07-23T00:00:00.000Z",
          autoRenew: true,
          resourceType: "app",
          appId: APP_ID,
          containerId: null,
          agentId: null,
          mcpId: null,
          cloudflareZoneId: "zone-scenario-1",
        },
      ],
    });
    return;
  }

  if (
    method === "GET" &&
    url.pathname === `/api/v1/apps/${APP_ID}/domains/${DOMAIN_NAME}/dns`
  ) {
    json(res, 200, {
      success: true,
      domain: DOMAIN_NAME,
      records: [
        {
          id: "dns-scenario-1",
          type: "A",
          name: DOMAIN_NAME,
          content: "192.0.2.10",
          ttl: 1,
          proxied: true,
          createdOn: "2026-07-23T12:00:00.000Z",
          modifiedOn: "2026-07-23T12:00:00.000Z",
        },
      ],
    });
    return;
  }

  json(res, 404, { success: false, error: "not found" });
}

async function startCloudMock(): Promise<string> {
  cloudCalls.length = 0;
  cloudApp = initialCloudApp();
  cloudServer = http.createServer((req, res) => {
    // error-policy:J1 the loopback HTTP boundary translates fixture failures.
    handleCloudRequest(req, res).catch((error) => {
      json(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((resolve) => cloudServer?.listen(0, resolve));
  const address = cloudServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  publicUrl = "https://scenario-project.frontends.test";
  const delegateFetch = globalThis.fetch;
  originalFetch = delegateFetch;
  // Publication status requires HTTPS; local routing keeps the liveness probe
  // on a real socket without depending on public DNS or test certificates.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestedUrl =
      input instanceof Request ? input.url : input.toString();
    if (requestedUrl === publicUrl) {
      return delegateFetch(`${baseUrl}/published/scenario-project`, init);
    }
    return delegateFetch(input, init);
  }) as typeof fetch;
  return baseUrl;
}

async function stopCloudMock(): Promise<void> {
  const server = cloudServer;
  cloudServer = null;
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runtimeFromContext(ctx: ScenarioContext): CloudAppsScenarioRuntime {
  if (!isCloudAppsScenarioRuntime(ctx.runtime)) {
    throw new Error("scenario runtime is missing Cloud Apps settings methods");
  }
  return ctx.runtime;
}

function assertPublicationLedger(): string | undefined {
  if (countCalls("POST", "/api/v1/apps") !== 1) {
    return `expected one Cloud app create, saw ${countCalls("POST", "/api/v1/apps")}`;
  }
  const frontendPath = `/api/v1/apps/${APP_ID}/frontend`;
  if (countCalls("POST", frontendPath) !== 1) {
    return `expected one managed frontend deployment, saw ${countCalls("POST", frontendPath)}`;
  }
  const frontendCall = callsFor("POST", frontendPath)[0];
  if (frontendCall?.projectBindingAtCall !== APP_ID) {
    return `expected cloudAppId binding before deploy, saw ${String(frontendCall?.projectBindingAtCall)}`;
  }
  const frontendBody = isRecord(frontendCall?.body) ? frontendCall.body : null;
  const files = Array.isArray(frontendBody?.files) ? frontendBody.files : [];
  if (
    frontendBody?.activate !== true ||
    files.length !== 1 ||
    !isRecord(files[0]) ||
    files[0].path !== "index.html"
  ) {
    return `unexpected managed frontend request ${JSON.stringify(frontendBody)}`;
  }

  const patchPath = `/api/v1/apps/${APP_ID}`;
  const patches = callsFor("PATCH", patchPath);
  if (patches.length !== 3) {
    return `expected deactivate → activate → unpublish PATCH sequence, saw ${patches.length}`;
  }
  const patchBodies = patches.map((call) =>
    isRecord(call.body) ? call.body : {},
  );
  if (
    patchBodies[0]?.is_active !== false ||
    patchBodies[1]?.is_active !== true ||
    patchBodies[1]?.app_url !== publicUrl ||
    !Array.isArray(patchBodies[1]?.allowed_origins) ||
    patchBodies[1]?.allowed_origins[0] !== publicUrl ||
    patchBodies[2]?.is_active !== false
  ) {
    return `unexpected Cloud activation sequence ${JSON.stringify(patchBodies)}`;
  }
  if (countCalls("DELETE", `/api/v1/apps/${APP_ID}`) !== 0) {
    return "unpublish must not delete the Cloud app";
  }
  const publicProbes = callsFor("GET", "/published/scenario-project");
  if (publicProbes.length !== 1 || publicProbes[0]?.authorization !== null) {
    return `expected one unauthenticated public URL probe, saw ${JSON.stringify(publicProbes)}`;
  }
  const unauthenticatedCloudCall = cloudCalls.find(
    (call) =>
      call.pathname.startsWith("/api/v1/") &&
      call.authorization !== "Bearer scenario-cloud-key",
  );
  if (unauthenticatedCloudCall) {
    return `Cloud SDK call lacked its bearer token: ${JSON.stringify(unauthenticatedCloudCall)}`;
  }
  if (countCalls("POST", "/api/v1/domains/search") !== 1) {
    return "expected one registrar-catalog search";
  }
  if (countCalls("GET", "/api/v1/domains") !== 1) {
    return "expected one organization domain inventory read";
  }
  if (
    countCalls("GET", `/api/v1/apps/${APP_ID}/domains/${DOMAIN_NAME}/dns`) !== 1
  ) {
    return "expected one managed DNS-record read";
  }
  return undefined;
}

function assertPersistedBinding(): string | undefined {
  const project = getProjectById(projectId);
  if (!project) return "scenario project disappeared from projects.json";
  if (project.cloudAppId !== APP_ID) {
    return `expected preserved cloudAppId ${APP_ID}, saw ${String(project.cloudAppId)}`;
  }
  const registry = readProjectRegistry();
  if (registry?.activeProjectId !== projectId) {
    return `expected active project ${projectId}, saw ${String(registry?.activeProjectId)}`;
  }
  if (cloudApp.is_active !== false) {
    return "expected Cloud row inactive after confirmed unpublish";
  }
  return undefined;
}

export default scenario({
  id: "cloud-project-publication-lifecycle",
  lane: "pr-deterministic",
  title:
    "Published project lifecycle exposes safe domain reads and confirms unpublish",
  domain: "cloud-apps",
  status: "active",
  tags: [
    "cloud-apps",
    "projects",
    "publish",
    "domains",
    "structured-confirm",
    "keyless",
  ],
  requires: {
    plugins: ["@elizaos/plugin-cloud-apps"],
  },
  seed: [
    {
      type: "custom",
      name: "start loopback Cloud and register a real active project",
      apply: async (ctx) => {
        const baseUrl = await startCloudMock();
        stateDir = mkdtempSync(join(os.tmpdir(), "project-publish-scenario-"));
        projectDir = join(stateDir, "scenario-project");
        mkdirSync(projectDir, { recursive: true });
        previousStateDir = process.env.ELIZA_STATE_DIR;
        process.env.ELIZA_STATE_DIR = stateDir;
        const project = upsertProject({
          name: PROJECT_NAME,
          localPath: projectDir,
        });
        projectId = project.id;
        if (!setActiveProject(project.id)) {
          throw new Error("failed to activate the scenario project");
        }

        const runtime = runtimeFromContext(ctx);
        await runtime.registerPlugin(cloudAppsPlugin);
        runtime.setSetting("ELIZAOS_CLOUD_API_KEY", "scenario-cloud-key", true);
        runtime.setSetting(
          "ELIZAOS_CLOUD_BASE_URL",
          `${baseUrl}/api/v1`,
          false,
        );
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "publish active project with managed frontend",
      actionName: "PUBLISH_PROJECT",
      text: "publish my project",
      options: {
        project: PROJECT_NAME,
        mode: "managed-frontend",
        files: [
          {
            path: "index.html",
            content:
              "<!doctype html><html><title>Scenario Project</title></html>",
            encoding: "utf8",
          },
        ],
      },
      responseIncludesAll: [PROJECT_NAME, "published at"],
      assertTurn: expectDataFlag("published", true),
    },
    {
      kind: "action",
      name: "read live published status with analytics and earnings",
      actionName: "GET_PUBLISHED_PROJECT",
      text: "how is my project doing?",
      options: { project: PROJECT_NAME },
      responseIncludesAll: [
        "published at",
        "Requests: 42",
        "Users: 7",
        "Lifetime earnings: $125.00",
      ],
      assertTurn: expectDataFlag("published", true),
    },
    {
      kind: "action",
      name: "search the registrar catalog without buying",
      actionName: "SEARCH_DOMAINS",
      text: "find two domains for this project",
      options: { query: "scenario", limit: 2 },
      responseIncludesAll: [
        DOMAIN_NAME,
        "$13.60",
        "scenario.app",
        "unavailable",
      ],
      assertTurn: (turn) => {
        const data = responseData(turn);
        const candidates = Array.isArray(data.candidates)
          ? data.candidates
          : [];
        return candidates.length === 2
          ? undefined
          : `expected two search candidates, saw ${candidates.length}`;
      },
    },
    {
      kind: "action",
      name: "list the complete managed-domain inventory",
      actionName: "LIST_MANAGED_DOMAINS",
      text: "list every managed domain",
      responseIncludesAll: [
        DOMAIN_NAME,
        "registered through Eliza Cloud",
        "assigned to a published project",
      ],
      assertTurn: (turn) => {
        const domains = responseData(turn).domains;
        return Array.isArray(domains) && domains.length === 1
          ? undefined
          : `expected one managed domain, saw ${JSON.stringify(domains)}`;
      },
    },
    {
      kind: "action",
      name: "list managed DNS through project resolution",
      actionName: "LIST_DOMAIN_DNS_RECORDS",
      text: `show DNS records for ${DOMAIN_NAME}`,
      options: { project: PROJECT_NAME, domain: DOMAIN_NAME },
      responseIncludesAll: [DOMAIN_NAME, "192.0.2.10", "proxied"],
      assertTurn: (turn) => {
        const records = responseData(turn).records;
        return Array.isArray(records) && records.length === 1
          ? undefined
          : `expected one DNS record, saw ${JSON.stringify(records)}`;
      },
    },
    {
      kind: "action",
      name: "unpublish first ask stores confirmation without mutation",
      actionName: "UNPUBLISH_PROJECT",
      text: "unpublish my project",
      options: { project: PROJECT_NAME },
      responseIncludesAll: [PROJECT_NAME, "confirm unpublish"],
      assertTurn: (turn) => {
        const flagError = expectDataFlag("confirmationRequired", true)(turn);
        if (flagError) return flagError;
        const patchCount = countCalls("PATCH", `/api/v1/apps/${APP_ID}`);
        return patchCount === 2
          ? undefined
          : `first unpublish ask mutated Cloud; expected 2 publish PATCHes, saw ${patchCount}`;
      },
    },
    {
      kind: "action",
      name: "plain yes remains non-authorizing",
      actionName: "UNPUBLISH_PROJECT",
      text: "yes",
      responseIncludesAll: ["waiting for confirmation"],
      assertTurn: (turn) => {
        const flagError = expectDataFlag("confirmationRequired", true)(turn);
        if (flagError) return flagError;
        const patchCount = countCalls("PATCH", `/api/v1/apps/${APP_ID}`);
        return patchCount === 2
          ? undefined
          : `plain prose confirmation mutated Cloud; saw ${patchCount} PATCHes`;
      },
    },
    {
      kind: "action",
      name: "structured confirm deactivates but preserves binding",
      actionName: "UNPUBLISH_PROJECT",
      text: "confirmar",
      options: { confirm: true },
      responseIncludesAll: [
        PROJECT_NAME,
        "is unpublished",
        "binding are preserved",
      ],
      assertTurn: expectDataFlag("unpublished", true),
    },
    {
      kind: "action",
      name: "status now reports unpublished while retaining history",
      actionName: "GET_PUBLISHED_PROJECT",
      text: "is my project still published?",
      options: { project: PROJECT_NAME },
      responseIncludesAll: [
        "currently unpublished",
        "Requests: 42",
        "Users: 7",
        "Lifetime earnings: $125.00",
      ],
      assertTurn: expectDataFlag("published", false),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "Cloud request ledger proves one create and safe lifecycle",
      predicate: assertPublicationLedger,
    },
    {
      type: "custom",
      name: "projects.json keeps the active Cloud binding after unpublish",
      predicate: assertPersistedBinding,
    },
    {
      type: "actionCalled",
      name: "publish executed through the real action pipeline",
      actionName: "PUBLISH_PROJECT",
      minCount: 1,
    },
    {
      type: "actionCalled",
      name: "publication status executed before and after unpublish",
      actionName: "GET_PUBLISHED_PROJECT",
      minCount: 2,
    },
    {
      type: "actionCalled",
      name: "unpublish exercised non-authorizing and confirmed turns",
      actionName: "UNPUBLISH_PROJECT",
      minCount: 3,
    },
    {
      type: "actionCalled",
      name: "registrar search executed through the real SDK transport",
      actionName: "SEARCH_DOMAINS",
      minCount: 1,
    },
    {
      type: "actionCalled",
      name: "organization domain inventory executed through the real SDK transport",
      actionName: "LIST_MANAGED_DOMAINS",
      minCount: 1,
    },
    {
      type: "actionCalled",
      name: "managed DNS read executed through project resolution",
      actionName: "LIST_DOMAIN_DNS_RECORDS",
      minCount: 1,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "stop loopback Cloud and restore project registry environment",
      apply: async () => {
        await stopCloudMock();
        if (originalFetch) globalThis.fetch = originalFetch;
        originalFetch = null;
        if (previousStateDir === undefined) {
          delete process.env.ELIZA_STATE_DIR;
        } else {
          process.env.ELIZA_STATE_DIR = previousStateDir;
        }
        if (stateDir) rmSync(stateDir, { recursive: true, force: true });
        stateDir = null;
        projectDir = null;
        projectId = "";
      },
    },
  ],
});

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "../../../../packages/scenario-runner/schema/index.js";
import { scenario } from "../../../../packages/scenario-runner/schema/index.js";
import { cloudAppsPlugin } from "../../src/index.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const NEW_API_KEY = "eliza_scenario_new_key_123";

interface CloudMockCall {
  method: string;
  pathname: string;
  body: unknown;
  authorization: string | null;
}

interface CloudAppsScenarioRuntime {
  registerPlugin(plugin: typeof cloudAppsPlugin): void | Promise<void>;
  setSetting(key: string, value: string, isSecret?: boolean): void;
}

const cloudCalls: CloudMockCall[] = [];
let cloudServer: http.Server | null = null;

const app = {
  id: APP_ID,
  name: "Acme Bot",
  description: "Scenario app",
  slug: "acme-bot",
  organization_id: "org-scenario",
  created_by_user_id: "user-scenario",
  app_url: "https://placeholder.invalid",
  allowed_origins: [],
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
  deployment_status: "deployed",
  production_url: "https://acme-bot.example.test",
  last_deployed_at: "2026-07-01T00:00:00.000Z",
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
  is_active: true,
  is_approved: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  last_used_at: null,
};

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
  const body = turn.responseBody;
  return isRecord(body) && isRecord(body.data) ? body.data : {};
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

function requestBody(
  method: string,
  pathname: string,
): Record<string, unknown> | null {
  const call = cloudCalls.find(
    (candidate) =>
      candidate.method === method && candidate.pathname === pathname,
  );
  return isRecord(call?.body) ? call.body : null;
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
  if (!raw.trim()) return null;
  return JSON.parse(raw);
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
  });

  if (method === "GET" && url.pathname === "/api/v1/apps") {
    json(res, 200, { success: true, apps: [app] });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}`) {
    json(res, 200, { success: true, app });
    return;
  }

  if (method === "DELETE" && url.pathname === `/api/v1/apps/${APP_ID}`) {
    json(res, 200, {
      success: true,
      message: "deleted",
      cleaned: {
        domainsRemoved: 0,
        githubRepoDeleted: false,
        secretBindingsRemoved: 1,
        managedDomainsUnlinked: 0,
        containersTornDown: 1,
      },
    });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === `/api/v1/apps/${APP_ID}/regenerate-api-key`
  ) {
    json(res, 200, {
      success: true,
      apiKey: NEW_API_KEY,
      message: "rotated",
    });
    return;
  }

  if (method === "GET" && url.pathname === `/api/v1/apps/${APP_ID}/earnings`) {
    json(res, 200, {
      success: true,
      earnings: {
        summary: {
          withdrawableBalance: 125,
          pendingBalance: 0,
          totalLifetimeEarnings: 125,
          totalWithdrawn: 0,
          payoutThreshold: 25,
        },
      },
      monetization: { enabled: true },
    });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === `/api/v1/apps/${APP_ID}/earnings/withdraw`
  ) {
    json(res, 200, {
      success: true,
      message: "withdrawal recorded",
      transactionId: "txn_scenario_1",
      newBalance: 75,
    });
    return;
  }

  json(res, 404, { success: false, error: "not found" });
}

async function startCloudMock(): Promise<string> {
  cloudCalls.length = 0;
  cloudServer = http.createServer((req, res) => {
    handleCloudRequest(req, res).catch((error) => {
      json(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((resolve) => cloudServer?.listen(0, resolve));
  const address = cloudServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
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
    throw new Error("scenario runtime is missing cloud-apps settings methods");
  }
  return ctx.runtime;
}

export default scenario({
  id: "cloud-apps-structured-confirm",
  lane: "pr-deterministic",
  title: "Cloud Apps destructive actions require structured confirmation",
  domain: "cloud-apps",
  status: "active",
  tags: ["cloud-apps", "safety", "structured-confirm"],
  requires: {
    plugins: ["@elizaos/plugin-cloud-apps"],
  },
  seed: [
    {
      type: "custom",
      name: "start loopback cloud API and configure runtime settings",
      apply: async (ctx) => {
        const baseUrl = await startCloudMock();
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
      name: "delete first ask only stores confirmation",
      actionName: "DELETE_APP",
      text: "delete Acme Bot",
      options: { appName: "Acme Bot" },
      responseIncludesAll: ["This will delete", "Acme Bot", "can't be undone"],
      assertTurn: expectDataFlag("confirmationRequired", true),
    },
    {
      kind: "action",
      name: "plain yes does not delete",
      actionName: "DELETE_APP",
      text: "yes",
      responseIncludesAll: ["waiting for confirmation"],
      assertTurn: expectDataFlag("deleted", false),
    },
    {
      kind: "action",
      name: "structured delete confirmation deletes once",
      actionName: "DELETE_APP",
      text: "confirmar",
      options: { confirm: true },
      responseIncludesAll: ["Deleted", "Acme Bot"],
      assertTurn: expectDataFlag("deleted", true),
    },
    {
      kind: "action",
      name: "rotation first ask only stores confirmation",
      actionName: "REGENERATE_APP_API_KEY",
      text: "rotate Acme Bot key",
      options: { appName: "Acme Bot" },
      responseIncludesAll: ["regenerate", "Acme Bot", "current key"],
      assertTurn: expectDataFlag("confirmationRequired", true),
    },
    {
      kind: "action",
      name: "structured rotation confirmation returns key once",
      actionName: "REGENERATE_APP_API_KEY",
      text: "confirmo",
      options: { confirm: true },
      responseIncludesAll: [NEW_API_KEY, "won't be shown again"],
      assertTurn: expectDataFlag("rotated", true),
    },
    {
      kind: "action",
      name: "withdraw first ask stores amount and CTA",
      actionName: "WITHDRAW_APP_EARNINGS",
      text: "withdraw $50 from Acme Bot",
      options: { appName: "Acme Bot", amount: 50 },
      responseIncludesAll: ["payout of $50.00", "Acme Bot", "dashboard"],
      assertTurn: expectDataFlag("confirmationRequired", true),
    },
    {
      kind: "action",
      name: "structured withdrawal uses first-turn amount",
      actionName: "WITHDRAW_APP_EARNINGS",
      text: "confirm, actually make it $500",
      options: { confirm: true },
      responseIncludesAll: ["Requested a payout of $50.00", "Acme Bot"],
      assertTurn: expectDataFlag("withdrawn", true),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "loopback cloud received exactly one destructive call per confirmed action",
      predicate: () => {
        const deleteCount = countCalls("DELETE", `/api/v1/apps/${APP_ID}`);
        if (deleteCount !== 1) {
          return `expected one DELETE call, saw ${deleteCount}`;
        }
        const rotateCount = countCalls(
          "POST",
          `/api/v1/apps/${APP_ID}/regenerate-api-key`,
        );
        if (rotateCount !== 1) {
          return `expected one regenerate call, saw ${rotateCount}`;
        }
        const withdrawCount = countCalls(
          "POST",
          `/api/v1/apps/${APP_ID}/earnings/withdraw`,
        );
        if (withdrawCount !== 1) {
          return `expected one withdraw call, saw ${withdrawCount}`;
        }
        const withdrawBody = requestBody(
          "POST",
          `/api/v1/apps/${APP_ID}/earnings/withdraw`,
        );
        if (withdrawBody?.amount !== 50) {
          return `expected withdrawal amount 50 from first turn, saw ${String(
            withdrawBody?.amount,
          )}`;
        }
        if (typeof withdrawBody.idempotency_key !== "string") {
          return "expected withdrawal idempotency_key";
        }
        return undefined;
      },
    },
    {
      type: "actionCalled",
      name: "delete action executed through scenario runner",
      actionName: "DELETE_APP",
      minCount: 3,
    },
    {
      type: "actionCalled",
      name: "key rotation action executed through scenario runner",
      actionName: "REGENERATE_APP_API_KEY",
      minCount: 2,
    },
    {
      type: "actionCalled",
      name: "withdraw action executed through scenario runner",
      actionName: "WITHDRAW_APP_EARNINGS",
      minCount: 2,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "stop loopback cloud API",
      apply: async () => {
        await stopCloudMock();
      },
    },
  ],
});

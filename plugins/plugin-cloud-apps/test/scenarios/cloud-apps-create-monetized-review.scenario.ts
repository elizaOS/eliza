/**
 * "Create a monetized app" must degrade gracefully, not dead-end (#11863).
 *
 * The create-time monetization review gate (#11828) means the server never
 * enables monetization at create time. The agent one-shot flow still sends the
 * user's monetization intent; the server creates the app with monetization
 * OFF, persists the markup as a pricing default, and returns the review
 * requirement in `warnings`. This scenario drives the real CREATE_APP action
 * through the real SDK client against a loopback cloud API implementing that
 * contract and asserts the user gets an app + the review next-step — not a
 * hard failure.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "../../../../packages/scenario-runner/schema/index.js";
import { scenario } from "../../../../packages/scenario-runner/schema/index.js";
import { cloudAppsPlugin } from "../../src/index.js";

const APP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Mirrors `CREATE_TIME_MONETIZATION_WARNING` in packages/cloud/api/v1/apps/route.ts. */
const REVIEW_WARNING =
  "Monetization requires an approved app review, so the app was created with monetization disabled. Submit it for review (the Monetize tab in the dashboard, or POST /api/v1/apps/:id/review), then enable monetization after approval.";

interface CloudMockCall {
  method: string;
  pathname: string;
  body: unknown;
}

interface CloudAppsScenarioRuntime {
  registerPlugin(plugin: typeof cloudAppsPlugin): void | Promise<void>;
  setSetting(key: string, value: string, isSecret?: boolean): void;
}

const cloudCalls: CloudMockCall[] = [];
let cloudServer: http.Server | null = null;

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

/** The app row the loopback create endpoint returns: monetization forced off. */
function createdApp(name: string): Record<string, unknown> {
  return {
    id: APP_ID,
    name,
    description: null,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    organization_id: "org-scenario",
    created_by_user_id: "user-scenario",
    app_url: "https://placeholder.invalid",
    allowed_origins: [],
    api_key_id: "api-key-scenario",
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 0,
    total_users: 0,
    total_credits_used: "0.00",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: 20,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: "0.00",
    total_platform_revenue: "0.00",
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    review_status: "draft",
    review_content_hash: null,
    reviewed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    last_used_at: null,
  };
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
  cloudCalls.push({ method, pathname: url.pathname, body });

  if (method === "POST" && url.pathname === "/api/v1/apps") {
    const name =
      isRecord(body) && typeof body.name === "string" ? body.name : "App";
    const requestedMonetization =
      isRecord(body) && body.monetization_enabled === true;
    // Create-time monetization review gate contract (#11828 + #11863):
    // the app is created, monetization stays off, and the review requirement
    // comes back as a warning instead of a 403.
    json(res, 200, {
      success: true,
      app: createdApp(name),
      apiKey: "eliza_scenario_created_key_do_not_leak",
      ...(requestedMonetization ? { warnings: [REVIEW_WARNING] } : {}),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/apps") {
    json(res, 200, { success: true, apps: [] });
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
  id: "cloud-apps-create-monetized-review",
  lane: "pr-deterministic",
  title:
    "Create-a-monetized-app degrades gracefully: app created, monetization off, review step surfaced",
  domain: "cloud-apps",
  status: "active",
  tags: ["cloud-apps", "monetization", "review-gate", "ux"],
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
      name: "monetized create succeeds with review next-step, no dead 403",
      actionName: "CREATE_APP",
      text: "create a monetized app called Coin with 20% markup",
      responseIncludesAll: ["Coin", "review", "deploy"],
      assertTurn: (turn) => {
        const data = responseData(turn);
        if (data.monetization !== false) {
          return `expected data.monetization=false (fail-closed until review), saw ${String(data.monetization)}`;
        }
        if (data.reviewStatus !== "draft") {
          return `expected data.reviewStatus="draft", saw ${String(data.reviewStatus)}`;
        }
        const reply = turn.responseText ?? "";
        if (reply.includes("Monetization is on")) {
          return "reply falsely claims monetization is enabled";
        }
        if (reply.includes("eliza_scenario_created_key_do_not_leak")) {
          return "reply leaked the one-time app API key into chat";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "loopback cloud saw one create carrying the user's monetization intent",
      predicate: () => {
        const creates = cloudCalls.filter(
          (call) => call.method === "POST" && call.pathname === "/api/v1/apps",
        );
        if (creates.length !== 1) {
          return `expected one POST /api/v1/apps, saw ${creates.length}`;
        }
        const body = isRecord(creates[0].body) ? creates[0].body : null;
        if (body?.name !== "Coin") {
          return `expected create name "Coin", saw ${String(body?.name)}`;
        }
        if (body?.monetization_enabled !== true) {
          return `expected monetization_enabled=true in the create body, saw ${String(body?.monetization_enabled)}`;
        }
        if (body?.inference_markup_percentage !== 20) {
          return `expected inference_markup_percentage=20, saw ${String(body?.inference_markup_percentage)}`;
        }
        return undefined;
      },
    },
    {
      type: "actionCalled",
      name: "create action executed through scenario runner",
      actionName: "CREATE_APP",
      minCount: 1,
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

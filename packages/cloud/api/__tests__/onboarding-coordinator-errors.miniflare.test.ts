/**
 * Dispatches the production public onboarding route through a declared
 * Miniflare Durable Object namespace and verifies typed authorization mapping.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const ROUTE_BOUNDARIES = {
  users:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]db[\\/]repositories[\\/]users\.ts$/,
  auth: /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]auth[\\/]workers-hono-auth\.ts$/,
  session:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]index\.ts$/,
  internalAuth: /packages[\\/]cloud[\\/]api[\\/]internal[\\/]_auth\.ts$/,
  provisioning:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]provisioning\.ts$/,
  cache:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]cache[\\/]client\.ts$/,
  userService:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]user-service\.ts$/,
  managedLaunch:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-managed-launch\.ts$/,
  proactiveGreeting:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]onboarding-proactive-greeting\.ts$/,
  logger:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]logger\.ts$/,
  cloudBindings:
    /packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]runtime[\\/]cloud-bindings\.ts$/,
} as const;

const NESTED_BUILD_DEPENDENCIES: Record<string, string> = {
  "libphonenumber-js": "../../shared/node_modules/libphonenumber-js/index.js",
  "@noble/ciphers/aes.js": "../../../core/node_modules/@noble/ciphers/aes.js",
  "@noble/hashes/legacy.js":
    "../../../core/node_modules/@noble/hashes/legacy.js",
  "@noble/hashes/sha2.js": "../../../core/node_modules/@noble/hashes/sha2.js",
};

type GreetingReplies = {
  "enqueue-greeting": { success: boolean };
  "drain-greetings": { greetings: Array<{ leaseId: string }> };
  "ack-greetings": { acknowledged: number };
};

describe("onboarding coordinator error integration", () => {
  let miniflare: Miniflare;

  beforeAll(async () => {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/onboarding-route-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      format: "esm",
      // Keep workerd's native Node imports without Bun's Node-only require bridge.
      target: "browser",
      external: ["node:*"],
      conditions: ["node", "import"],
      plugins: [
        {
          name: "onboarding-route-boundaries",
          setup(build) {
            // Bun's nested build does not inherit the test runner's workspace
            // package search roots. Resolve the production shim's direct
            // dependencies from each importing workspace, preserving pins.
            build.onResolve(
              {
                filter:
                  /^(?:libphonenumber-js|@noble\/ciphers\/aes\.js|@noble\/hashes\/(?:legacy|sha2)\.js)$/,
              },
              (args) => {
                const relativePath = NESTED_BUILD_DEPENDENCIES[args.path];
                if (!relativePath) return undefined;
                return {
                  path: fileURLToPath(new URL(relativePath, import.meta.url)),
                };
              },
            );
            build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
              path: fileURLToPath(
                new URL("../../../core/src/index.ts", import.meta.url),
              ),
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.users }, () => ({
              loader: "ts",
              contents: `
                export function providerForPlatform() { return undefined; }
                export const usersRepository = { async resolveIdentity() { return null; } };
              `,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.auth }, () => ({
              loader: "ts",
              contents:
                "export async function getCurrentUser() { return null; }",
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.session }, () => ({
              loader: "ts",
              contents: `export const elizaAppSessionService = {
                async validateAuthHeader() { return null; }
              };`,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.internalAuth }, () => ({
              loader: "ts",
              contents: `export async function requireInternalAuth() {
                return new Response("Unauthorized", { status: 401 });
              }`,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.provisioning }, () => ({
              loader: "ts",
              contents: `
                const none = { status: "none", agentId: null, bridgeUrl: null, sandbox: null };
                export async function getElizaAppProvisioningStatus() { return none; }
                export function publicElizaAppProvisioningPayload(value) { return value; }
              `,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.cache }, () => ({
              loader: "ts",
              contents: `export const cache = {
                async get() { return null; },
                async set() {}
              };`,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.userService }, () => ({
              loader: "ts",
              contents: `export const elizaAppUserService = {
                async findOrCreateByPhone() { return { success: true }; },
                async linkPhoneToUser() { return { success: true }; },
                async linkDiscordToUser() { return { success: true }; },
                async linkTelegramToUser() { return { success: true }; }
              };`,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.managedLaunch }, () => ({
              loader: "ts",
              contents: `export async function launchManagedElizaAgent() {
                throw new Error("launch is outside this authorization test");
              }
              export async function readManagedElizaAgentConnection() {
                throw new Error("connection reads are outside this authorization test");
              }`,
            }));
            build.onLoad(
              { filter: ROUTE_BOUNDARIES.proactiveGreeting },
              () => ({
                loader: "ts",
                contents: `
                  export const PROACTIVE_GREETING_QUEUE_PREFIX = "proactive-greetings:";
                  export async function enqueueDiscordProactiveGreeting() {}
                `,
              }),
            );
            build.onLoad({ filter: ROUTE_BOUNDARIES.logger }, () => ({
              loader: "ts",
              contents: `export const logger = {
                debug() {}, info() {}, warn() {}, error() {}
              };`,
            }));
            build.onLoad({ filter: ROUTE_BOUNDARIES.cloudBindings }, () => ({
              loader: "ts",
              contents: `
                let bindings;
                export async function runWithCloudBindingsAsync(next, operation) {
                  const previous = bindings;
                  bindings = next;
                  try { return await operation(); }
                  finally { bindings = previous; }
                }
                export function getCloudBinding(name) { return bindings?.[name]; }
                export function hasCloudBindingsContext() { return bindings !== undefined; }
                export function getCloudAwareEnv() { return {}; }
              `,
            }));
          },
        },
      ],
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs,
        "Failed to bundle onboarding Worker",
      );
    }
    const output = build.outputs[0];
    if (!output) throw new Error("Onboarding Worker bundle was not emitted");

    miniflare = new Miniflare({
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script: await output.text(),
      durableObjects: {
        ONBOARDING_SESSIONS: {
          className: "OnboardingSessionCoordinator",
          useSQLite: true,
        },
      },
    });
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  function coordinatorRequest(owner: string, path: string, body: unknown) {
    return miniflare.dispatchFetch("https://cloud.test/fixture/coordinator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, path, body }),
    });
  }

  function greetingQueue(name: string) {
    return async <Name extends keyof GreetingReplies>(
      path: Name,
      body: unknown,
    ): Promise<GreetingReplies[Name]> => {
      const response = await coordinatorRequest(
        `proactive-greetings:${name}`,
        path,
        body,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as GreetingReplies[Name];
    };
  }

  async function continuation(name: string) {
    const id = `platform:continuation-${name}`;
    const session = {
      id,
      platform: "telegram",
      platformIdentityTrusted: true,
      platformUserId: "fixture-telegram",
      createdAt: new Date().toISOString(),
      history: [],
    };
    const claim = {
      claimId: "original-lineage",
      telegramId: session.platformUserId,
      phoneNumber: "+15550100000",
    };
    const account = { userId: "fixture-user", organizationId: "fixture-org" };
    const send = async (owner: string, path: string, body: unknown) => {
      const response = await coordinatorRequest(owner, path, body);
      return { status: response.status, body: await response.json() };
    };
    const token = `continuation-fixture-${name}`;
    expect(await send(token, "bind", { sessionId: id })).toMatchObject({
      status: 200,
    });
    return {
      id,
      claim,
      account,
      request: (path: string, body: unknown) => send(token, path, body),
      seed: async (
        fields: Partial<typeof session> & Partial<typeof account>,
      ) => {
        expect(
          await send(id, "fixture/session", { ...session, ...fields }),
        ).toMatchObject({ status: 200 });
      },
    };
  }

  test("public route maps a typed coordinator rejection to fail-closed 403", async () => {
    const response = await miniflare.dispatchFetch(
      "https://cloud.test/api/eliza-app/onboarding/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "forged-continuation",
          confirmPlatformLink: true,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error:
        "Authenticate with the same messaging account that started this onboarding session",
      code: "access_denied",
    });
  }, 120_000);

  test("concurrent greeting drains lease the original enqueue to one poller", async () => {
    const queue = greetingQueue("concurrent");
    const original = {
      sessionId: "platform:queue-original",
      platformUserId: "test-recipient",
      message: "Original greeting",
      createdAt: new Date().toISOString(),
      deliveryNonce: "original",
    };
    await queue("enqueue-greeting", original);
    await queue("enqueue-greeting", { ...original, message: "Duplicate" });
    const replies = await Promise.all([
      queue("drain-greetings", { limit: 1 }),
      queue("drain-greetings", { limit: 1 }),
    ]);
    const claims = replies.flatMap((reply) => reply.greetings);
    expect(claims).toHaveLength(1);
    const [claim] = claims;
    expect(claim).toMatchObject(original);
    const acknowledgement = {
      sessionId: original.sessionId,
      leaseId: claim.leaseId,
    };
    expect(
      await queue("ack-greetings", {
        acknowledgements: [{ ...acknowledgement, leaseId: "other" }],
      }),
    ).toEqual({ acknowledged: 0 });
    expect(await queue("drain-greetings", {})).toEqual({ greetings: [] });
    expect(
      await queue("ack-greetings", { acknowledgements: [acknowledgement] }),
    ).toEqual({ acknowledged: 1 });
    expect(
      await queue("ack-greetings", { acknowledgements: [acknowledgement] }),
    ).toEqual({ acknowledged: 0 });
    await queue("enqueue-greeting", { ...original, deliveryNonce: "new" });
    const next = await queue("drain-greetings", {});
    expect(next.greetings).toEqual([
      expect.objectContaining({ deliveryNonce: "new" }),
    ]);
  });

  test("an expired lease can be replaced and its delayed acknowledgement has no effect", async () => {
    const queue = greetingQueue("recovery");
    const now = Date.now();
    const original = {
      sessionId: "platform:queue-recovery",
      platformUserId: "test-recipient",
      message: "Recovered greeting",
      createdAt: new Date(now - 3 * 60_000).toISOString(),
      deliveryNonce: "recovery",
    };
    await queue("enqueue-greeting", {
      ...original,
      lease: { id: "retired", expiresAt: now - 60_000 },
    });
    await queue("enqueue-greeting", {
      ...original,
      sessionId: "platform:queue-expired",
      createdAt: new Date(now - 16 * 60_000).toISOString(),
    });
    const reply = await queue("drain-greetings", {});
    expect(reply.greetings).toHaveLength(1);
    const [claim] = reply.greetings;
    expect(claim).toMatchObject(original);
    expect(claim.leaseId).not.toBe("retired");
    expect(
      await queue("ack-greetings", {
        acknowledgements: [
          { sessionId: original.sessionId, leaseId: "retired" },
        ],
      }),
    ).toEqual({ acknowledged: 0 });
    expect(
      await queue("ack-greetings", {
        acknowledgements: [
          { sessionId: original.sessionId, leaseId: claim.leaseId },
        ],
      }),
    ).toEqual({ acknowledged: 1 });
    expect(await queue("drain-greetings", {})).toEqual({ greetings: [] });
  });

  test("continuation pins the original lineage and account through exact completion", async () => {
    const { id, claim, account, request, seed } = await continuation("owner");
    await seed({});
    expect(await request("claim", claim)).toEqual({
      status: 200,
      body: { status: "acquired", sessionId: id },
    });
    expect(
      await request("claim", { ...claim, claimId: "other-lineage" }),
    ).toMatchObject({ status: 409 });
    const owned = { ...claim, ...account };
    expect(await request("claim", owned)).toMatchObject({ status: 200 });
    expect(
      await request("claim", { ...owned, userId: "other-account" }),
    ).toMatchObject({ status: 409 });
    expect(await request("complete-claim", owned)).toMatchObject({
      status: 409,
    });
    await seed(account);
    expect(
      await request("complete-claim", { ...owned, claimId: "other-lineage" }),
    ).toMatchObject({ status: 409 });
    expect(await request("complete-claim", owned)).toEqual({
      status: 200,
      body: { status: "completed" },
    });
    expect(await request("claim", owned)).toEqual({
      status: 200,
      body: { status: "completed", sessionId: id, ...account },
    });
  });

  test("continuation rejects invalid sessions and recovers a retained completed claim", async () => {
    const { id, claim, account, request, seed } =
      await continuation("recovery");
    await seed({ platformIdentityTrusted: false });
    expect(await request("claim", claim)).toMatchObject({ status: 403 });
    await seed({
      createdAt: new Date(Date.now() - 15 * 24 * 60 * 60_000).toISOString(),
    });
    expect(await request("claim", claim)).toMatchObject({ status: 403 });
    await seed({});
    expect(
      await request("claim", { ...claim, telegramId: "other-telegram" }),
    ).toMatchObject({ status: 403 });
    expect(await request("claim", claim)).toMatchObject({ status: 200 });
    await seed(account);
    const owned = { ...claim, ...account };
    expect(await request("claim", owned)).toEqual({
      status: 200,
      body: { status: "completed", sessionId: id, ...account },
    });
    expect(await request("complete-claim", owned)).toMatchObject({
      status: 409,
    });
  });

  test("replay created behind the cleanup cursor keeps an expiry alarm", async () => {
    const reply = await miniflare.dispatchFetch(
      "https://cloud.test/fixture/replay-case",
    );
    expect(reply.status).toBe(200);
    const state = (await reply.json()) as {
      count: number;
      expiry: number;
      alarm: number | null;
    };
    expect(state.count).toBe(1);
    expect(state.alarm).toBe(state.expiry);
  });
});

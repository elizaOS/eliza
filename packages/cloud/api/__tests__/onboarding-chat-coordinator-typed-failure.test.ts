/**
 * Proves typed onboarding failures cross a real workerd Durable Object binding
 * and that malformed coordinator bodies cannot manufacture authorization
 * outcomes at the public HTTP route.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const MODULE_FILTERS = {
  users:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]db[\\/]repositories[\\/]users\.ts$/,
  auth: /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]auth[\\/]workers-hono-auth\.ts$/,
  sessionService:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]index\.ts$/,
  cache:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]cache[\\/]client\.ts$/,
  provisioning:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]provisioning\.ts$/,
  userService:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]user-service\.ts$/,
  managedLaunch:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-managed-launch\.ts$/,
  proactiveGreeting:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]services[\\/]eliza-app[\\/]onboarding-proactive-greeting\.ts$/,
  phoneNormalization:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]phone-normalization\.ts$/,
  internalAuth:
    /(?:^|[\\/])packages[\\/]cloud[\\/]api[\\/]internal[\\/]_auth\.ts$/,
  cloudBindings:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]runtime[\\/]cloud-bindings\.ts$/,
  logger:
    /(?:^|[\\/])packages[\\/]cloud[\\/]shared[\\/]src[\\/]lib[\\/]utils[\\/]logger\.ts$/,
} as const;

describe("onboarding chat typed failures across a workerd Durable Object boundary", () => {
  let miniflare: Miniflare;

  beforeAll(async () => {
    const build = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            "../test/fixtures/onboarding-coordinator-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      format: "esm",
      target: "browser",
      conditions: ["worker", "browser"],
      plugins: [
        {
          name: "onboarding-runtime-boundaries",
          setup(build) {
            build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
              path: "elizaos-core-test",
              namespace: "onboarding-test",
            }));
            build.onLoad(
              { filter: /.*/, namespace: "onboarding-test" },
              () => ({
                loader: "ts",
                contents: `
                  export class ElizaError extends Error {
                    code;
                    context;
                    constructor(message, options) {
                      super(message);
                      this.name = "ElizaError";
                      this.code = options.code;
                      this.context = options.context;
                    }
                  }
                  export function isElizaError(value) {
                    return value instanceof ElizaError;
                  }
                `,
              }),
            );
            build.onLoad({ filter: MODULE_FILTERS.users }, () => ({
              loader: "ts",
              contents: `
                export function providerForPlatform() { return undefined; }
                export const usersRepository = { async resolveIdentity() { return null; } };
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.auth }, () => ({
              loader: "ts",
              contents: `export async function getCurrentUser() { return null; }`,
            }));
            build.onLoad({ filter: MODULE_FILTERS.sessionService }, () => ({
              loader: "ts",
              contents: `
                export const elizaAppSessionService = {
                  async validateAuthHeader() { return null; }
                };
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.cache }, () => ({
              loader: "ts",
              contents: `
                export const cache = {
                  async get() { return null; },
                  async set() {},
                  async delete() {},
                };
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.provisioning }, () => ({
              loader: "ts",
              contents: `
                const none = { status: "none", agentId: null, bridgeUrl: null, sandbox: null };
                export async function ensureElizaAppProvisioning() { return none; }
                export async function getElizaAppProvisioningStatus() { return none; }
                export function publicElizaAppProvisioningPayload(value) { return value; }
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.userService }, () => ({
              loader: "ts",
              contents: `
                export const elizaAppUserService = {
                  async findOrCreateByPhone() { return null; },
                  async linkPhoneToUser() { return { success: true }; },
                  async linkDiscordToUser() { return { success: true }; },
                  async linkTelegramToUser() { return { success: true }; },
                };
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.managedLaunch }, () => ({
              loader: "ts",
              contents: `export async function launchManagedElizaAgent() { return null; }`,
            }));
            build.onLoad({ filter: MODULE_FILTERS.proactiveGreeting }, () => ({
              loader: "ts",
              contents: `
                export const PROACTIVE_GREETING_QUEUE_PREFIX = "test";
                export async function enqueueDiscordProactiveGreeting() {}
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.phoneNormalization }, () => ({
              loader: "ts",
              contents: `
                export function normalizePhoneNumber(value) { return value; }
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.internalAuth }, () => ({
              loader: "ts",
              contents: `export async function requireInternalAuth() { return true; }`,
            }));
            build.onLoad({ filter: MODULE_FILTERS.cloudBindings }, () => ({
              loader: "ts",
              contents: `
                let active;
                export async function runWithCloudBindingsAsync(bindings, operation) {
                  const previous = active;
                  active = bindings;
                  try { return await operation(); }
                  finally { active = previous; }
                }
                export function getCloudBinding(name) { return active?.[name]; }
                export function hasCloudBindingsContext() { return active !== undefined; }
                export function getCloudAwareEnv() { return active ?? {}; }
              `,
            }));
            build.onLoad({ filter: MODULE_FILTERS.logger }, () => ({
              loader: "ts",
              contents: `
                export const logger = {
                  debug() {}, info() {}, warn() {}, error() {},
                };
              `,
            }));
          },
        },
      ],
    });
    if (!build.success) {
      throw new AggregateError(
        build.logs,
        "Failed to bundle onboarding test Worker",
      );
    }
    const output = build.outputs[0];
    if (!output)
      throw new Error("Onboarding test Worker bundle was not emitted");

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
        MALFORMED_ONBOARDING_SESSIONS: {
          className: "MalformedOnboardingCoordinator",
          useSQLite: true,
        },
      },
    });
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  async function post(mode: string): Promise<{
    status: number;
    json(): Promise<unknown>;
  }> {
    const response = await miniflare.dispatchFetch(
      `https://onboarding.test/${mode}`,
      {
        method: "POST",
      },
    );
    return {
      status: response.status,
      json: async () => await response.json(),
    };
  }

  test("the public route maps a production coordinator rejection to 403", async () => {
    const response = await post("actual");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "access_denied",
    });
  }, 120_000);

  test("a valid typed control still maps to the intended authorization response", async () => {
    expect((await post("typed")).status).toBe(403);
  });

  for (const mode of [
    "unreadable",
    "null",
    "array",
    "missing-error",
    "non-string-error",
    "non-string-code",
    "empty-code",
  ]) {
    test(`malformed coordinator response ${mode} remains a generic 500`, async () => {
      const response = await post(mode);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        success: false,
        code: "internal_error",
      });
    });
  }
});

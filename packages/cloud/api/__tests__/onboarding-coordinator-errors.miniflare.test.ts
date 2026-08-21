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
      target: "browser",
      conditions: ["worker", "browser"],
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
                new URL("../src/stubs/elizaos-core.ts", import.meta.url),
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
});

/**
 * Keyless per-plugin e2e for `@elizaos/plugin-shopify` (issue #8801).
 *
 * Exercises the SHOPIFY connector end-to-end against a local mock of the
 * Shopify Admin GraphQL API (the `ELIZA_MOCK_SHOPIFY_BASE` wire-mock seam,
 * mirroring plugin-openai/anthropic). The seed starts an in-process mock that
 * returns an empty product list and points the connector at it with dummy
 * credentials; the agent's "list products" request routes to the SHOPIFY action
 * which calls the mock and reports "No products found" — keyless, no live store.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const SHOPIFY = "SHOPIFY";

/** GraphQL request bodies the Admin API mock actually served. */
let adminApiRequests: string[] = [];

type R = AgentRuntime & {
  setSetting?: (k: string, v: string) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "shopify.list-products",
  title: "Shopify: list products against a mocked Admin API",
  domain: "shopify",
  tags: ["smoke", "shopify", "connector"],
  description:
    "Lists Shopify products through the SHOPIFY action against a local mock of the Admin GraphQL API — keyless, no live store, no credentials.",

  requires: { plugins: ["@elizaos/plugin-shopify"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "shopify-mock-and-config",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        adminApiRequests = [];
        // 1. In-process mock of the Shopify Admin GraphQL endpoint.
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            adminApiRequests.push(await request.text());
            return new Response(
              JSON.stringify({
                data: {
                  products: {
                    edges: [],
                    pageInfo: { hasNextPage: false, hasPreviousPage: false },
                  },
                  shop: {
                    name: "Mock Store",
                    currencyCode: "USD",
                    primaryDomain: { url: "https://mock-store.myshopify.com" },
                  },
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          },
        });
        const base = `http://localhost:${server.port}/admin/api/graphql.json`;
        // 2. Point the connector at the mock with dummy credentials.
        process.env.ELIZA_MOCK_SHOPIFY_BASE = base;
        process.env.SHOPIFY_STORE_DOMAIN = "mock-store.myshopify.com";
        process.env.SHOPIFY_ACCESS_TOKEN = "test-shpat-token";
        runtime.setSetting?.(
          "SHOPIFY_STORE_DOMAIN",
          "mock-store.myshopify.com",
        );
        runtime.setSetting?.("SHOPIFY_ACCESS_TOKEN", "test-shpat-token");
        // 3. Routing fixtures.
        runtime.scenarioLlmFixtures?.register(
          {
            name: "shopify-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("Shopify products"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["shopify"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [SHOPIFY],
            },
            times: 1,
          },
          {
            name: "shopify-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("Shopify products"),
              toolName: SHOPIFY,
            },
            response: {
              text: "",
              thought: "List the store's products.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-shopify",
                  name: SHOPIFY,
                  type: "function",
                  arguments: { action: "products" },
                },
              ],
            },
            times: 1,
          },
          {
            // manage-products intent classification (TEXT_SMALL), if reached.
            name: "shopify-intent",
            match: { modelType: ModelType.TEXT_SMALL },
            response: JSON.stringify({ action: "list", query: null }),
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Shopify" },
  ],

  turns: [
    {
      kind: "message",
      name: "list",
      text: "List my Shopify products.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === SHOPIFY);
        if (!call) {
          return `Expected ${SHOPIFY} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${SHOPIFY} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: SHOPIFY,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the SHOPIFY products op really queried the
      // Admin GraphQL mock (a products query hit the wire) and surfaced the
      // mock's empty-store answer — not just "the handler returned success".
      type: "custom",
      name: "shopify-list-products-effect",
      predicate: (ctx) => {
        const productsQuery = adminApiRequests.find((body) =>
          body.toLowerCase().includes("products"),
        );
        if (!productsQuery) {
          return `Admin API mock never received a products query; served ${adminApiRequests.length} request(s): ${adminApiRequests
            .map((body) => body.slice(0, 120))
            .join(" | ")}`;
        }
        const call = successfulCalls(ctx, SHOPIFY).find(
          (candidate) => toRecord(candidate.result?.data)?.op === "products",
        );
        if (!call) {
          return `no successful SHOPIFY call routed the products op; calls: ${describeCalls(ctx)}`;
        }
        if (call.result?.text !== "No products found") {
          return `expected the empty-store read ("No products found") in the action result, saw ${JSON.stringify(call.result?.text ?? null)}`;
        }
      },
    },
  ],
});

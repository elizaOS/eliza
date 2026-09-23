/** Checkout tests prove preview completeness, stable binding, and receipt honesty. */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  assertVerifiedOrderReceipt,
  buildCheckoutBinding,
  checkoutPreviewDigest,
  doorDashAction,
} from "./action.js";
import type { DoorDashMcpService } from "./types.js";

describe("DoorDash checkout safety", () => {
  const cart = { items: [{ name: "Ramen", quantity: 1, price: 15.99 }] };
  const preview = {
    success: true,
    requiresConfirmation: true,
    summary: { total: 23.42, deliveryAddress: "123 Main St" },
  };

  it("binds cart and checkout independent of object key order", () => {
    const left = buildCheckoutBinding(cart, preview);
    const right = buildCheckoutBinding(
      { items: [{ price: 15.99, quantity: 1, name: "Ramen" }] },
      {
        summary: { deliveryAddress: "123 Main St", total: 23.42 },
        requiresConfirmation: true,
        success: true,
      },
    );
    expect(checkoutPreviewDigest(left)).toBe(checkoutPreviewDigest(right));
  });

  it("changes the confirmation digest when the total changes", () => {
    const original = checkoutPreviewDigest(buildCheckoutBinding(cart, preview));
    const changed = checkoutPreviewDigest(
      buildCheckoutBinding(cart, {
        ...preview,
        summary: { ...preview.summary, total: 25.01 },
      }),
    );
    expect(changed).not.toBe(original);
  });

  it("rejects empty carts and zero totals", () => {
    expect(() => buildCheckoutBinding({ items: [] }, preview)).toThrow(
      /cart is empty/i,
    );
    expect(() =>
      buildCheckoutBinding(cart, {
        ...preview,
        summary: { ...preview.summary, total: 0 },
      }),
    ).toThrow(/positive total/i);
  });

  it("rejects the reviewed adapter's synthetic fallback order ID", () => {
    expect(() =>
      assertVerifiedOrderReceipt({
        success: true,
        orderId: "order-1787000000000",
      }),
    ).toThrow(/authoritative order ID/i);
    expect(() =>
      assertVerifiedOrderReceipt({ success: true, orderId: "abc123" }),
    ).not.toThrow();
  });

  it("prefers the built-in Browser workspace for app turns", async () => {
    const runtime = routingRuntime(true);
    const available = await doorDashAction.validate?.(
      runtime,
      {
        content: {
          text: "find ramen",
          source: "client_chat",
          metadata: { viewClientId: "app-device-1" },
        },
      } as Memory,
      undefined,
    );
    expect(available).toBe(false);
  });

  it("uses Cloudflare DoorDash for connector turns", async () => {
    const available = await doorDashAction.validate?.(
      routingRuntime(true),
      { content: { text: "find ramen", source: "imessage" } } as Memory,
      undefined,
    );
    expect(available).toBe(true);
  });

  it("falls back to Cloudflare when an app has no Browser workspace", async () => {
    const available = await doorDashAction.validate?.(
      routingRuntime(false),
      {
        content: {
          text: "find ramen",
          source: "client_chat",
          metadata: { viewClientId: "app-device-1" },
        },
      } as Memory,
      undefined,
    );
    expect(available).toBe(true);
  });

  it("returns a linkable structured human handoff for connector turns", async () => {
    const liveViewUrl = "https://live.browser.run/session?token=secret";
    const value = {
      success: true,
      authRequired: true,
      humanInterventionRequired: true,
      humanInterventionKind: "cloudflare-browser-run",
      loginUrl: liveViewUrl,
      appBrowserPath: `/browser?browse=${encodeURIComponent(liveViewUrl)}`,
      appDeepLink: `elizaos://browser?browse=${encodeURIComponent(liveViewUrl)}`,
      handoffId: "handoff-1",
      handoffState: "active",
    };
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "connected",
          tools: [{ name: "doordash_auth_check" }],
        },
      ],
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
      }),
    };
    const runtime = {
      getService: (name: string) => (name === "mcp" ? mcp : null),
    } as unknown as IAgentRuntime;

    const result = await doorDashAction.handler?.(
      runtime,
      { content: { text: "connect DoorDash", source: "imessage" } } as Memory,
      undefined,
      { parameters: { action: "status" } },
    );

    expect(result.values).toMatchObject({
      provider: "doordash",
      humanInterventionRequired: true,
      liveViewUrl,
      handoffId: "handoff-1",
    });
    expect(result.userFacingText).toContain("elizaos://browser");
    expect(result.userFacingText).toContain("select Done");
  });

  it("routes a Cloudflare provider block to DoorDash in Eliza's built-in browser", async () => {
    const liveViewUrl = "https://live.browser.run/session?token=secret";
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "connected",
          tools: [{ name: "doordash_auth_check" }],
        },
      ],
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              authRequired: true,
              humanInterventionRequired: true,
              providerBlocked: true,
              loginUrl: liveViewUrl,
              nativeLoginUrl: "https://www.doordash.com/consumer/login",
            }),
          },
        ],
      }),
    };
    const runtime = {
      getService: (name: string) => (name === "mcp" ? mcp : null),
    } as unknown as IAgentRuntime;

    const result = await doorDashAction.handler?.(
      runtime,
      { content: { text: "connect DoorDash", source: "imessage" } } as Memory,
      undefined,
      { parameters: { action: "status" } },
    );

    expect(result.values).toMatchObject({
      providerBlocked: true,
      liveViewUrl,
      appBrowserPath:
        "/browser?browse=https%3A%2F%2Fwww.doordash.com%2Fconsumer%2Flogin",
      appDeepLink:
        "elizaos://browser?browse=https%3A%2F%2Fwww.doordash.com%2Fconsumer%2Flogin",
      nativeAppDeepLink:
        "elizaos://browser?browse=https%3A%2F%2Fwww.doordash.com%2Fconsumer%2Flogin",
    });
    expect(result.userFacingText).toContain("not a CAPTCHA");
    expect(result.userFacingText).toContain("built-in browser");
  });

  it("rejects a human handoff outside Cloudflare Live View", async () => {
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "connected",
          tools: [{ name: "doordash_auth_check" }],
        },
      ],
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              humanInterventionRequired: true,
              loginUrl: "https://attacker.example/phish",
              appBrowserPath: "/browser?browse=javascript%3Aalert(1)",
              appDeepLink: "elizaos://browser?browse=javascript%3Aalert(1)",
            }),
          },
        ],
      }),
    };
    const runtime = {
      getService: (name: string) => (name === "mcp" ? mcp : null),
    } as unknown as IAgentRuntime;

    const result = await doorDashAction.handler?.(
      runtime,
      { content: { text: "connect DoorDash", source: "imessage" } } as Memory,
      undefined,
      { parameters: { action: "status" } },
    );

    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("DOORDASH_INVALID_HANDOFF");
    expect(result.userFacingText).not.toContain("attacker.example");
  });

  it("ignores a model confirmation flag and purchases only after the user's next yes", async () => {
    const cache = new Map<string, unknown>();
    const calls: Array<{
      toolName: string;
      args: Readonly<Record<string, unknown>>;
    }> = [];
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "connected",
          tools: [
            { name: "doordash_auth_check" },
            { name: "doordash_auth_clear" },
            { name: "doordash_cart" },
            {
              name: "doordash_checkout",
              inputSchema: {
                type: "object",
                properties: {
                  conversationId: { type: "string" },
                  expectedCheckoutDigest: { type: "string" },
                },
                required: ["conversationId"],
              },
            },
          ],
        },
      ],
      callTool: async (_serverName, toolName, args = {}) => {
        calls.push({ toolName, args });
        if (toolName === "doordash_cart") {
          return { content: [{ type: "text", text: JSON.stringify(cart) }] };
        }
        if (args.confirm === true) {
          return {
            content: [
              {
                type: "text",
                text: '{"success":true,"orderId":"dd-real-123"}',
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(preview) }] };
      },
    };
    const runtime = {
      getService: () => mcp,
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => {
        cache.delete(key);
      },
    } as unknown as IAgentRuntime;
    const callbacks: string[] = [];
    const callback: HandlerCallback = async (content) => {
      callbacks.push(content.text ?? "");
      return [];
    };
    const options = { parameters: { action: "place_order", confirm: true } };

    const first = await doorDashAction.handler?.(
      runtime,
      {
        entityId: "user-1",
        roomId: "conversation-1",
        content: { text: "place the order" },
      } as Memory,
      undefined,
      options,
      callback,
    );
    expect(first.data?.awaitingUserInput).toBe(true);
    expect(calls.filter((call) => call.args.confirm === true)).toHaveLength(0);
    expect(callbacks[0]).toContain("23.42");

    const second = await doorDashAction.handler?.(
      runtime,
      {
        entityId: "user-1",
        roomId: "conversation-1",
        content: { text: "yes" },
      } as Memory,
      undefined,
      options,
      callback,
    );
    expect(second.success).toBe(true);
    expect(calls.filter((call) => call.args.confirm === true)).toHaveLength(1);
    expect(
      calls.find((call) => call.args.confirm === true)?.args,
    ).toMatchObject({
      conversationId: "conversation-1",
      expectedCheckoutDigest: first.data?.checkoutDigest,
    });
    expect(second.data?.result).toEqual({
      success: true,
      orderId: "dd-real-123",
    });
  });

  it("requires a user follow-up before clearing the adapter session", async () => {
    const cache = new Map<string, unknown>();
    let clearCalls = 0;
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "connected",
          tools: [{ name: "doordash_auth_clear" }],
        },
      ],
      callTool: async () => {
        clearCalls += 1;
        return { content: [{ type: "text", text: '{"success":true}' }] };
      },
    };
    const runtime = {
      getService: () => mcp,
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
      deleteCache: async (key: string) => {
        cache.delete(key);
      },
    } as unknown as IAgentRuntime;
    const options = { parameters: { action: "clear_session", confirm: true } };

    const first = await doorDashAction.handler?.(
      runtime,
      {
        entityId: "user-1",
        content: { text: "disconnect DoorDash" },
      } as Memory,
      undefined,
      options,
    );
    expect(first.data?.awaitingUserInput).toBe(true);
    expect(clearCalls).toBe(0);

    await doorDashAction.handler?.(
      runtime,
      { entityId: "user-1", content: { text: "yes" } } as Memory,
      undefined,
      options,
    );
    expect(clearCalls).toBe(1);
  });
});

function routingRuntime(hasBrowser: boolean): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "browser"
        ? hasBrowser
          ? {
              resolveTarget: async () => ({ id: "workspace", kind: "app" }),
            }
          : null
        : {
            getServers: () => [
              {
                name: "doordash",
                status: "connected",
                tools: [{ name: "doordash_search" }],
              },
            ],
          },
  } as unknown as IAgentRuntime;
}

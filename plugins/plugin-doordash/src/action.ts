/** Agent-facing DoorDash action with exact checkout preview confirmation. */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonObject,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError, gateDestructiveConfirmation, logger } from "@elizaos/core";
import { createHash } from "@elizaos/core/utils/crypto-compat";
import { callDoorDashOperation, hasDoorDashCapability } from "./adapter.js";
import {
  DOORDASH_OPERATIONS,
  type DoorDashMcpService,
  type DoorDashOperation,
} from "./types.js";

const MCP_SERVICE_NAME = "mcp";
const BROWSER_SERVICE_NAME = "browser";
const APP_MESSAGE_SOURCES = new Set(["client_chat", "client-ambient"]);

interface InAppBrowserService {
  resolveTarget(
    preferredId: string,
    command: { subaction: "state" },
  ): Promise<{ id: string; kind?: string } | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parameters(
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const nested = (options as HandlerOptions).parameters;
  return isRecord(nested) ? nested : (options as Record<string, unknown>);
}

function normalizeOperation(value: unknown): DoorDashOperation | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  return (DOORDASH_OPERATIONS as readonly string[]).includes(normalized)
    ? (normalized as DoorDashOperation)
    : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    ) as JsonObject;
  }
  return String(value);
}

interface DoorDashHumanIntervention {
  readonly liveViewUrl: string;
  readonly appBrowserPath: string;
  readonly appDeepLink: string;
  readonly handoffId?: string;
  readonly handoffState?: string;
  readonly providerBlocked: boolean;
  readonly nativeAppDeepLink?: string;
}

function humanIntervention(value: unknown): DoorDashHumanIntervention | null {
  if (!isRecord(value) || value.humanInterventionRequired !== true) return null;
  if (typeof value.loginUrl !== "string") {
    return null;
  }
  let liveViewUrl: string;
  try {
    const parsed = new URL(value.loginUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "live.browser.run"
    ) {
      return null;
    }
    liveViewUrl = parsed.href;
  } catch {
    // error-policy:J3 untrusted MCP handoff output is never rendered as a link.
    return null;
  }
  let nativeAppDeepLink: string | undefined;
  if (
    value.providerBlocked === true &&
    typeof value.nativeLoginUrl === "string"
  ) {
    try {
      const native = new URL(value.nativeLoginUrl);
      if (
        native.protocol === "https:" &&
        native.hostname === "www.doordash.com"
      ) {
        nativeAppDeepLink = `elizaos://browser?browse=${encodeURIComponent(native.href)}`;
      }
    } catch {
      // error-policy:J3 untrusted native fallback URLs are omitted.
    }
  }
  return {
    liveViewUrl,
    appBrowserPath: `/browser?browse=${encodeURIComponent(liveViewUrl)}`,
    appDeepLink: `elizaos://browser?browse=${encodeURIComponent(liveViewUrl)}`,
    providerBlocked: value.providerBlocked === true,
    ...(nativeAppDeepLink ? { nativeAppDeepLink } : {}),
    ...(typeof value.handoffId === "string"
      ? { handoffId: value.handoffId }
      : {}),
    ...(typeof value.handoffState === "string"
      ? { handoffState: value.handoffState }
      : {}),
  };
}

function humanInterventionText(handoff: DoorDashHumanIntervention): string {
  if (handoff.providerBlocked && handoff.nativeAppDeepLink) {
    return [
      "DoorDash rejected Cloudflare Browser Run's browser or network, so this is not a CAPTCHA you can solve in Live View.",
      `Open DoorDash directly in Eliza's built-in browser: ${handoff.nativeAppDeepLink}`,
      `Cloudflare Live View is still available for inspection: ${handoff.liveViewUrl}`,
      "Sign in there, then ask me to continue. I will not place an order without a separate explicit confirmation.",
    ].join("\n");
  }
  return [
    "DoorDash needs you to complete sign-in or a security check.",
    `Open the secure browser in Eliza: ${handoff.appDeepLink}`,
    `If the app link is unavailable, open Cloudflare Live View: ${handoff.liveViewUrl}`,
    "Complete only the verification/sign-in step, select Done, then ask me to continue. I will not place an order without a separate explicit confirmation.",
  ].join("\n");
}

export function checkoutPreviewDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function cartHasItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (cart) =>
        isRecord(cart) && Array.isArray(cart.items) && cart.items.length > 0,
    );
  }
  return (
    isRecord(value) && Array.isArray(value.items) && value.items.length > 0
  );
}

function checkoutTotal(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const summary = isRecord(value.summary) ? value.summary : value;
  return typeof summary.total === "number" && Number.isFinite(summary.total)
    ? summary.total
    : null;
}

export function buildCheckoutBinding(
  cart: unknown,
  preview: unknown,
): Record<string, unknown> {
  if (!cartHasItems(cart)) {
    throw new ElizaError(
      "DoorDash checkout cannot be confirmed because the cart is empty or unreadable.",
      {
        code: "DOORDASH_CHECKOUT_PREVIEW_INCOMPLETE",
        context: { missing: "cart_items" },
        severity: "ephemeral",
      },
    );
  }
  const total = checkoutTotal(preview);
  if (total === null || total <= 0) {
    throw new ElizaError(
      "DoorDash checkout cannot be confirmed without a positive total.",
      {
        code: "DOORDASH_CHECKOUT_PREVIEW_INCOMPLETE",
        context: { missing: "positive_total" },
        severity: "ephemeral",
      },
    );
  }
  return { cart, checkout: preview };
}

export function assertVerifiedOrderReceipt(value: unknown): void {
  if (!isRecord(value) || value.success !== true) {
    throw new ElizaError(
      "DoorDash did not return a successful order receipt.",
      {
        code: "DOORDASH_ORDER_UNVERIFIED",
        severity: "ephemeral",
      },
    );
  }
  const orderId = value.orderId;
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    /^order-\d+$/.test(orderId.trim())
  ) {
    throw new ElizaError(
      "DoorDash checkout response did not contain an authoritative order ID.",
      {
        code: "DOORDASH_ORDER_UNVERIFIED",
        context: { receiptKind: "missing_or_synthetic_order_id" },
        severity: "ephemeral",
      },
    );
  }
}

function previewPrompt(value: unknown): string {
  const summary =
    isRecord(value) && isRecord(value.summary) ? value.summary : value;
  return [
    "Please confirm this exact DoorDash checkout. Reply yes to place the order or anything else to cancel.",
    JSON.stringify(summary, null, 2),
  ].join("\n");
}

async function reply(
  result: ActionResult,
  callback: HandlerCallback | undefined,
  source: string | undefined,
): Promise<ActionResult> {
  if (result.userFacingText) {
    await callback?.({
      text: result.userFacingText,
      source,
      actions: ["DOORDASH"],
    });
  }
  return result;
}

function service(runtime: IAgentRuntime): DoorDashMcpService | null {
  return runtime.getService(MCP_SERVICE_NAME) as DoorDashMcpService | null;
}

function isAppBrowserTurn(message: Memory): boolean {
  const source = message.content.source?.trim().toLowerCase();
  if (source && APP_MESSAGE_SOURCES.has(source)) return true;
  const metadata = isRecord(message.content.metadata)
    ? message.content.metadata
    : null;
  return (
    typeof metadata?.viewClientId === "string" &&
    metadata.viewClientId.trim().length > 0
  );
}

async function hasInAppBrowser(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  if (!isAppBrowserTurn(message)) return false;
  const browser = runtime.getService(
    BROWSER_SERVICE_NAME,
  ) as InAppBrowserService | null;
  if (!browser) return false;
  try {
    const target = await browser.resolveTarget("workspace", {
      subaction: "state",
    });
    return target?.id === "workspace" && target.kind === "app";
  } catch (error) {
    // error-policy:J4 An unavailable app target degrades to the isolated
    // Cloudflare browser path without claiming that the local browser worked.
    logger.debug(
      `[DOORDASH] In-app browser availability check failed; using Cloudflare fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function execute(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions | Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const args = parameters(options);
  const scopedArgs = {
    ...args,
    conversationId: message.roomId,
  };
  const operation = normalizeOperation(
    args.action ?? args.op ?? args.operation,
  );
  if (!operation) {
    return reply(
      {
        success: false,
        text: "A valid DoorDash operation is required.",
        userFacingText:
          "Tell me whether to search restaurants, show a menu, manage the cart, preview checkout, place the order, or track an order.",
      },
      callback,
      message.content.source,
    );
  }

  const mcp = service(runtime);
  if (!mcp || !hasDoorDashCapability(mcp)) {
    return reply(
      {
        success: false,
        text: "No connected DoorDash MCP adapter.",
        userFacingText:
          "DoorDash is not connected. Configure a server named doordash in plugin-mcp or set MCP_SERVER_DOORDASH_URL.",
        data: { reason: "adapter_unavailable" },
      },
      callback,
      message.content.source,
    );
  }

  try {
    if (operation === "clear_session") {
      const decision = await gateDestructiveConfirmation({
        runtime,
        message,
        actionName: "DOORDASH_CLEAR_SESSION",
        pendingKey:
          typeof args.serverName === "string" ? args.serverName : "doordash",
        prompt:
          "Clear the connected DoorDash session? You will need to authenticate again before using it.",
        callback,
        ttlMs: 5 * 60_000,
      });
      if (decision.status === "pending") {
        return {
          success: true,
          text: "DoorDash session clearing is awaiting explicit user confirmation.",
          data: { awaitingUserInput: true },
        };
      }
      if (decision.status === "cancelled") {
        return reply(
          {
            success: true,
            text: "DoorDash session clearing cancelled.",
            userFacingText: "Cancelled. I kept the DoorDash session connected.",
            data: { cancelled: true },
          },
          callback,
          message.content.source,
        );
      }
    }

    if (operation === "place_order") {
      const cart = await callDoorDashOperation(
        mcp,
        "cart",
        scopedArgs,
        typeof args.serverName === "string" ? args.serverName : undefined,
      );
      const preview = await callDoorDashOperation(
        mcp,
        "preview_checkout",
        scopedArgs,
        typeof args.serverName === "string" ? args.serverName : undefined,
      );
      const binding = buildCheckoutBinding(cart.value, preview.value);
      const digest = checkoutPreviewDigest(binding);
      const decision = await gateDestructiveConfirmation({
        runtime,
        message,
        actionName: "DOORDASH_PLACE_ORDER",
        pendingKey: digest,
        prompt: previewPrompt(binding),
        callback,
        ttlMs: 5 * 60_000,
        metadata: { digest },
      });
      if (decision.status === "pending") {
        return {
          success: true,
          text: "DoorDash checkout is awaiting explicit user confirmation.",
          data: {
            awaitingUserInput: true,
            checkoutDigest: digest,
            preview: toJsonValue(binding),
          },
        };
      }
      if (decision.status === "cancelled") {
        return reply(
          {
            success: true,
            text: "DoorDash checkout cancelled.",
            userFacingText: "Cancelled. I did not place the DoorDash order.",
            data: { cancelled: true, checkoutDigest: digest },
          },
          callback,
          message.content.source,
        );
      }
      const placed = await callDoorDashOperation(
        mcp,
        "place_order",
        { ...scopedArgs, expectedCheckoutDigest: digest },
        typeof args.serverName === "string" ? args.serverName : undefined,
      );
      assertVerifiedOrderReceipt(placed.value);
      return reply(
        {
          success: true,
          text:
            placed.text ||
            "DoorDash adapter accepted the confirmed checkout request.",
          userFacingText:
            placed.text || "DoorDash accepted the confirmed checkout request.",
          data: {
            checkoutDigest: digest,
            serverName: placed.serverName,
            toolName: placed.toolName,
            result: toJsonValue(placed.value),
          },
        },
        callback,
        message.content.source,
      );
    }

    const called = await callDoorDashOperation(
      mcp,
      operation,
      scopedArgs,
      typeof args.serverName === "string" ? args.serverName : undefined,
    );
    const handoff = humanIntervention(called.value);
    if (
      isRecord(called.value) &&
      called.value.humanInterventionRequired === true &&
      !handoff
    ) {
      throw new ElizaError(
        "DoorDash returned an invalid human-intervention link.",
        {
          code: "DOORDASH_INVALID_HANDOFF",
          severity: "ephemeral",
        },
      );
    }
    const responseText = handoff
      ? humanInterventionText(handoff)
      : called.text || JSON.stringify(called.value);
    return reply(
      {
        success: true,
        text: responseText,
        userFacingText: responseText,
        ...(handoff
          ? {
              values: {
                provider: "doordash",
                humanInterventionRequired: true,
                humanInterventionKind: "cloudflare-browser-run",
                liveViewUrl: handoff.liveViewUrl,
                appBrowserPath: handoff.appBrowserPath,
                appDeepLink: handoff.appDeepLink,
                providerBlocked: handoff.providerBlocked,
                ...(handoff.nativeAppDeepLink
                  ? { nativeAppDeepLink: handoff.nativeAppDeepLink }
                  : {}),
                ...(handoff.handoffId ? { handoffId: handoff.handoffId } : {}),
                ...(handoff.handoffState
                  ? { handoffState: handoff.handoffState }
                  : {}),
              },
            }
          : {}),
        data: {
          serverName: called.serverName,
          toolName: called.toolName,
          result: toJsonValue(called.value),
        },
      },
      callback,
      message.content.source,
    );
  } catch (error) {
    // error-policy:J1 The action boundary translates typed adapter failures for the planner.
    if (!(error instanceof ElizaError)) throw error;
    logger.warn(
      { code: error.code, context: error.context },
      `[DOORDASH] ${error.message}`,
    );
    return reply(
      {
        success: false,
        text: error.message,
        userFacingText: error.message,
        error,
        data: { code: error.code },
      },
      callback,
      message.content.source,
    );
  }
}

export const doorDashAction: Action = {
  name: "DOORDASH",
  similes: [
    "ORDER_FOOD",
    "FOOD_DELIVERY",
    "SEARCH_RESTAURANTS",
    "DOORDASH_CART",
    "TRACK_DOORDASH_ORDER",
  ],
  description:
    "Cloudflare Browser Run fallback for DoorDash restaurant search, menus, cart, preview-bound checkout, history, and delivery tracking when the user is not in the Eliza app or its Browser workspace is unavailable. App turns use BROWSER so the user can see and authenticate in the built-in browser.",
  descriptionCompressed:
    "DoorDash restaurant search, menus, cart, confirmed checkout, history, order tracking.",
  routingHint:
    "DoorDash from iMessage or another connector without an app browser -> DOORDASH using Cloudflare Browser Run; DoorDash from the Eliza app with its Browser workspace -> BROWSER.",
  contexts: ["general", "connectors", "shopping", "food", "automation"],
  roleGate: { minRole: "USER" },
  tags: ["domain:shopping", "capability:external-side-effect"],
  parameters: [
    {
      name: "action",
      description: "DoorDash operation.",
      required: true,
      schema: { type: "string", enum: [...DOORDASH_OPERATIONS] },
    },
    {
      name: "query",
      description: "Restaurant, cuisine, or food search.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "address",
      description:
        "Delivery address for adapters that support setting it explicitly.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cuisine",
      description: "Optional cuisine filter.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "restaurantId",
      description: "Restaurant/store ID returned by search.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "menuId",
      description: "Menu ID required by some adapters.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "itemId",
      description: "Menu item or cart item ID.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "itemName",
      description: "Exact menu item name.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "unitPrice",
      description:
        "Item unit price in minor currency units when required by the adapter.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "quantity",
      description: "Item quantity from 1 through 99.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "currency",
      description: "ISO currency code; defaults to USD.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "specialInstructions",
      description: "Optional item instructions.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cartId",
      description: "Cart ID for removal.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "orderId",
      description: "Order ID for tracking.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Maximum history results.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "serverName",
      description: "Optional configured MCP server name; defaults to doordash.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime, message) =>
    hasDoorDashCapability(service(runtime)) &&
    !(await hasInAppBrowser(runtime, message)),
  handler: execute,
};

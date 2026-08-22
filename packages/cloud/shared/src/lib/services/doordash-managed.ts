/** Runs the first-party DoorDash MCP adapter in a user-and-conversation-bound browser session. */

import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { cache } from "../cache/client";
import { getCloudBinding } from "../runtime/cloud-bindings";
import type { HostedBrowserAuthContext } from "./browser-tools";
import {
  createDoorDashBrowserSession,
  type DoorDashBrowserSession,
  deleteDoorDashBrowserSession,
  executeDoorDashBrowserOperation,
  getDoorDashBrowserSession,
} from "./doordash-browser-run";

export interface DoorDashManagedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const SESSION_TTL_SECONDS = 3_600;

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties: {
    conversationId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Authenticated Eliza conversation scope for this browser session.",
    },
    ...properties,
  },
  required: ["conversationId", ...required],
  additionalProperties: false,
});

export const DOORDASH_MANAGED_TOOLS: readonly DoorDashManagedTool[] = [
  {
    name: "doordash_auth_check",
    description: "Check DoorDash login and return a secure interactive login view when needed.",
    inputSchema: objectSchema({}),
  },
  {
    name: "doordash_auth_clear",
    description: "Delete this user's hosted DoorDash session.",
    inputSchema: objectSchema({}),
  },
  {
    name: "doordash_set_address",
    description: "Set the DoorDash delivery address.",
    inputSchema: objectSchema({ address: { type: "string" } }, ["address"]),
  },
  {
    name: "doordash_search",
    description: "Search DoorDash restaurants.",
    inputSchema: objectSchema({ query: { type: "string" }, cuisine: { type: "string" } }, [
      "query",
    ]),
  },
  {
    name: "doordash_menu",
    description: "Read a restaurant menu.",
    inputSchema: objectSchema({ restaurantId: { type: "string" } }, ["restaurantId"]),
  },
  {
    name: "doordash_add_to_cart",
    description: "Add an exact menu item to the cart.",
    inputSchema: objectSchema(
      {
        restaurantId: { type: "string" },
        itemName: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: 99 },
        specialInstructions: { type: "string" },
      },
      ["restaurantId", "itemName"],
    ),
  },
  {
    name: "remove_from_cart",
    description: "Remove an item returned by the current cart view.",
    inputSchema: objectSchema({ cartId: { type: "string" }, itemId: { type: "string" } }, [
      "cartId",
      "itemId",
    ]),
  },
  {
    name: "doordash_cart",
    description: "Read the current DoorDash cart and totals.",
    inputSchema: objectSchema({}),
  },
  {
    name: "order_history",
    description: "List recent DoorDash orders.",
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 20 } }),
  },
  {
    name: "doordash_checkout",
    description:
      "Preview checkout or, only with confirm=true, submit the exact visible checkout once.",
    inputSchema: objectSchema({
      confirm: { type: "boolean" },
      expectedCheckoutDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description: "Digest of the exact cart and checkout preview the user confirmed.",
      },
    }),
  },
  {
    name: "doordash_track_order",
    description: "Read an order's current DoorDash status.",
    inputSchema: objectSchema({ orderId: { type: "string" } }),
  },
];

function requireIdentity(auth: HostedBrowserAuthContext): {
  conversationId: string;
  organizationId: string;
  userId: string;
} {
  const conversationId = auth.conversationId?.trim();
  const organizationId = auth.organizationId?.trim();
  const userId = auth.userId?.trim();
  if (!conversationId || !organizationId || !userId) {
    throw new Error(
      "DoorDash requires an authenticated Cloud user, organization, and conversation",
    );
  }
  return { conversationId, organizationId, userId };
}

function identityHash(auth: HostedBrowserAuthContext): string {
  const { conversationId, organizationId, userId } = requireIdentity(auth);
  return createHash("sha256")
    .update(`${organizationId}:${userId}:${conversationId}`)
    .digest("hex")
    .slice(0, 32);
}

export function getManagedDoorDashSessionKey(auth: HostedBrowserAuthContext): string {
  return `doordash:conversation:${identityHash(auth)}:session:v2`;
}

type CheckoutClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "completed"; readonly receipt: Record<string, unknown> };

async function checkoutGateRequest(
  auth: HostedBrowserAuthContext,
  path: "/claim" | "/complete",
  body: Record<string, unknown>,
): Promise<Response> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>("DOORDASH_CHECKOUT_GATES");
  if (!namespace) {
    throw new Error("DoorDash atomic checkout protection is unavailable");
  }
  return await namespace.getByName(identityHash(auth)).fetch(
    new Request(`https://doordash-checkout-gate${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function claimCheckout(
  auth: HostedBrowserAuthContext,
  digest: string,
): Promise<CheckoutClaim> {
  const response = await checkoutGateRequest(auth, "/claim", { digest });
  if (response.status === 409) {
    throw new Error("This DoorDash checkout submission was already attempted");
  }
  if (!response.ok) {
    throw new Error("DoorDash atomic checkout protection is unavailable");
  }
  const payload = (await response.json()) as {
    completed?: unknown;
    receipt?: unknown;
  };
  if (payload.completed === true) {
    if (!payload.receipt || typeof payload.receipt !== "object" || Array.isArray(payload.receipt)) {
      throw new Error("DoorDash checkout receipt storage returned an invalid result");
    }
    return { kind: "completed", receipt: payload.receipt as Record<string, unknown> };
  }
  return { kind: "claimed" };
}

async function completeCheckout(
  auth: HostedBrowserAuthContext,
  digest: string,
  receipt: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await checkoutGateRequest(auth, "/complete", { digest, receipt });
  if (!response.ok) {
    throw new Error(
      "DoorDash placed the order but could not persist its receipt; inspect the active session before retrying",
    );
  }
  const payload = (await response.json()) as { receipt?: unknown };
  if (!payload.receipt || typeof payload.receipt !== "object" || Array.isArray(payload.receipt)) {
    throw new Error("DoorDash checkout receipt storage returned an invalid result");
  }
  return payload.receipt as Record<string, unknown>;
}

async function storeSession(auth: HostedBrowserAuthContext, sessionId: string): Promise<void> {
  const outcome = await cache.setWithOutcome(
    getManagedDoorDashSessionKey(auth),
    sessionId,
    SESSION_TTL_SECONDS,
  );
  if (outcome.kind !== "written") {
    throw new Error("DoorDash session storage is unavailable");
  }
}

async function getOrCreateSession(auth: HostedBrowserAuthContext): Promise<DoorDashBrowserSession> {
  const key = getManagedDoorDashSessionKey(auth);
  const storedId = await cache.get<string>(key);
  if (storedId) {
    try {
      return await getDoorDashBrowserSession(storedId);
    } catch {
      // error-policy:J4 expired provider sessions are visibly replaced with a new login session.
      await cache.del(key);
    }
  }

  const created = await createDoorDashBrowserSession();
  try {
    await storeSession(auth, created.id);
  } catch (error) {
    await deleteDoorDashBrowserSession(created.id).catch(() => {
      // error-policy:J6 the primary durable-storage failure remains authoritative.
    });
    throw error;
  }
  return created;
}

async function clearSession(auth: HostedBrowserAuthContext): Promise<Record<string, unknown>> {
  const key = getManagedDoorDashSessionKey(auth);
  const sessionId = await cache.getAndDelete<string>(key);
  if (!sessionId) return { success: true, cleared: false };
  await deleteDoorDashBrowserSession(sessionId);
  return { success: true, cleared: true };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`DoorDash ${key} is required`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredConversationId(args: Record<string, unknown>): string {
  const conversationId = requiredString(args, "conversationId");
  if (conversationId.length > 256) {
    throw new Error("DoorDash conversationId must not exceed 256 characters");
  }
  return conversationId;
}

function validateManagedArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "doordash_auth_check":
    case "doordash_auth_clear":
    case "doordash_cart":
      return {};
    case "doordash_set_address":
      return { address: requiredString(args, "address") };
    case "doordash_search":
      return {
        query: requiredString(args, "query"),
        ...(optionalString(args, "cuisine") ? { cuisine: optionalString(args, "cuisine") } : {}),
      };
    case "doordash_menu":
      return { restaurantId: requiredString(args, "restaurantId") };
    case "doordash_add_to_cart": {
      const quantity = args.quantity === undefined ? 1 : args.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        throw new Error("DoorDash quantity must be an integer from 1 through 99");
      }
      return {
        restaurantId: requiredString(args, "restaurantId"),
        itemName: requiredString(args, "itemName"),
        quantity,
        ...(optionalString(args, "specialInstructions")
          ? { specialInstructions: optionalString(args, "specialInstructions") }
          : {}),
      };
    }
    case "remove_from_cart":
      return {
        cartId: requiredString(args, "cartId"),
        itemId: requiredString(args, "itemId"),
      };
    case "order_history": {
      const limit = args.limit === undefined ? 5 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error("DoorDash history limit must be an integer from 1 through 20");
      }
      return { limit };
    }
    case "doordash_checkout":
      if (args.confirm !== undefined && typeof args.confirm !== "boolean") {
        throw new Error("DoorDash confirm must be a boolean");
      }
      if (args.confirm === true) {
        const expectedCheckoutDigest = requiredString(args, "expectedCheckoutDigest");
        if (!/^[a-f0-9]{64}$/.test(expectedCheckoutDigest)) {
          throw new Error("DoorDash expectedCheckoutDigest must be a lowercase SHA-256 digest");
        }
        return { confirm: true, expectedCheckoutDigest };
      }
      return { confirm: false };
    case "doordash_track_order":
      return optionalString(args, "orderId") ? { orderId: optionalString(args, "orderId") } : {};
    default:
      throw new Error(`Unknown managed DoorDash tool: ${name}`);
  }
}

export async function callManagedDoorDashTool(
  name: string,
  args: Record<string, unknown>,
  auth: HostedBrowserAuthContext,
): Promise<Record<string, unknown>> {
  const scopedAuth: HostedBrowserAuthContext = {
    ...auth,
    conversationId: requiredConversationId(args),
  };
  requireIdentity(scopedAuth);
  if (name === "doordash_auth_clear") return clearSession(scopedAuth);
  if (!DOORDASH_MANAGED_TOOLS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown managed DoorDash tool: ${name}`);
  }
  const validatedArgs = validateManagedArgs(name, args);

  const session = await getOrCreateSession(scopedAuth);
  let checkoutDigest: string | undefined;
  if (name === "doordash_checkout" && validatedArgs.confirm === true) {
    checkoutDigest = requiredString(validatedArgs, "expectedCheckoutDigest");
    const claim = await claimCheckout(scopedAuth, checkoutDigest);
    if (claim.kind === "completed") return claim.receipt;
  }

  const payload = await executeDoorDashBrowserOperation(session.id, name, validatedArgs);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DoorDash browser returned an invalid result");
  }
  const result = payload as Record<string, unknown>;
  if (checkoutDigest) {
    if (
      result.success !== true ||
      typeof result.orderId !== "string" ||
      result.orderId.trim().length === 0 ||
      /^order-\d+$/i.test(result.orderId.trim())
    ) {
      throw new Error(
        "DoorDash submission outcome is ambiguous; inspect the active session before retrying",
      );
    }
    return await completeCheckout(scopedAuth, checkoutDigest, result);
  }
  if (name === "doordash_auth_check" && result.loggedIn !== true) {
    const securityVerificationRequired = result.securityVerificationRequired === true;
    return {
      ...result,
      success: true,
      authRequired: true,
      humanInterventionRequired: true,
      humanInterventionKind: "cloudflare-browser-run",
      loginUrl: session.interactiveLiveViewUrl,
      appBrowserPath: `/browser?browse=${encodeURIComponent(session.interactiveLiveViewUrl)}`,
      appDeepLink: `elizaos://browser?browse=${encodeURIComponent(session.interactiveLiveViewUrl)}`,
      instructions: securityVerificationRequired
        ? "Open appBrowserPath in the Eliza Browser tab (or loginUrl directly), complete DoorDash's security verification and sign in, then ask the agent to check DoorDash status again."
        : "Open appBrowserPath in the Eliza Browser tab (or loginUrl directly), sign in to DoorDash, then ask the agent to check DoorDash status again.",
    };
  }
  return { success: true, ...result };
}

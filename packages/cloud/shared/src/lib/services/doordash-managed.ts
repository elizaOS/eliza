/** Runs the first-party DoorDash MCP adapter in a user-bound hosted browser session. */

import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { cache } from "../cache/client";
import { getCloudBinding } from "../runtime/cloud-bindings";
import {
  createHostedBrowserSession,
  deleteHostedBrowserSession,
  executeHostedBrowserCommand,
  getHostedBrowserSession,
  type HostedBrowserAuthContext,
  type HostedBrowserTab,
} from "./browser-tools";

export interface DoorDashManagedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const SESSION_TTL_SECONDS = 3_600;
const BASE_URL = "https://www.doordash.com";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
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
    inputSchema: objectSchema({ confirm: { type: "boolean" } }),
  },
  {
    name: "doordash_track_order",
    description: "Read an order's current DoorDash status.",
    inputSchema: objectSchema({ orderId: { type: "string" } }),
  },
];

function requireIdentity(auth: HostedBrowserAuthContext): {
  organizationId: string;
  userId: string;
} {
  const organizationId = auth.organizationId?.trim();
  const userId = auth.userId?.trim();
  if (!organizationId || !userId) {
    throw new Error("DoorDash requires an authenticated Cloud user and organization");
  }
  return { organizationId, userId };
}

function identityHash(auth: HostedBrowserAuthContext): string {
  const { organizationId, userId } = requireIdentity(auth);
  return createHash("sha256").update(`${organizationId}:${userId}`).digest("hex").slice(0, 32);
}

export function getManagedDoorDashSessionKey(auth: HostedBrowserAuthContext): string {
  return `doordash:user:${identityHash(auth)}:session:v1`;
}

async function claimCheckout(auth: HostedBrowserAuthContext, digest: string): Promise<void> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>("DOORDASH_CHECKOUT_GATES");
  if (!namespace) {
    throw new Error("DoorDash atomic checkout protection is unavailable");
  }
  const response = await namespace.getByName(identityHash(auth)).fetch(
    new Request("https://doordash-checkout-gate/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest }),
    }),
  );
  if (response.status === 409) {
    throw new Error("This DoorDash checkout submission was already attempted");
  }
  if (!response.ok) {
    throw new Error("DoorDash atomic checkout protection is unavailable");
  }
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

async function getOrCreateSession(auth: HostedBrowserAuthContext): Promise<HostedBrowserTab> {
  const key = getManagedDoorDashSessionKey(auth);
  const storedId = await cache.get<string>(key);
  if (storedId) {
    try {
      return await getHostedBrowserSession(storedId, auth);
    } catch {
      // error-policy:J4 expired provider sessions are visibly replaced with a new login session.
      await cache.del(key);
    }
  }

  const created = await createHostedBrowserSession(
    {
      title: "DoorDash",
      ttl: SESSION_TTL_SECONDS,
      activityTtl: SESSION_TTL_SECONDS,
      url: `${BASE_URL}/consumer/login`,
    },
    auth,
  );
  try {
    await storeSession(auth, created.id);
  } catch (error) {
    await deleteHostedBrowserSession(created.id, auth).catch(() => {
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
  await deleteHostedBrowserSession(sessionId, auth);
  return { success: true, cleared: true };
}

function managedScript(name: string, args: Record<string, unknown>): string {
  return `
const op = ${JSON.stringify(name)};
const args = ${JSON.stringify(args)};
const base = ${JSON.stringify(BASE_URL)};
const visible = async (locator, timeout = 1500) => locator.isVisible({ timeout }).catch(() => false);
const bodyText = async () => (await page.locator("body").innerText().catch(() => ""));
const money = (text, label) => {
  const match = text.match(new RegExp(label + "[:\\s]*\\$(\\d+(?:\\.\\d{1,2})?)", "i"));
  return match ? Number(match[1]) : null;
};
const loginState = async () => {
  const login = page.locator('a[href*="consumer/login"], button:has-text("Sign In"), a:has-text("Sign In")').first();
  return { loggedIn: !(await visible(login)), url: page.url() };
};
let result;
if (op === "doordash_auth_check") {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  result = await loginState();
} else if (op === "doordash_set_address") {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const input = page.locator('input[placeholder*="delivery address" i], input[placeholder*="enter delivery" i], [role="combobox"][aria-label*="address" i]').first();
  if (!(await visible(input, 5000))) throw new Error("DoorDash address input was not found");
  await input.fill(String(args.address));
  await page.waitForTimeout(1500);
  const suggestion = page.locator('[role="option"], [role="listbox"] button').first();
  if (!(await visible(suggestion, 3000))) throw new Error("DoorDash returned no address suggestion");
  await suggestion.click();
  const confirm = page.locator('button:has-text("Save"), button:has-text("Done"), button:has-text("Confirm"), button:has-text("Find Restaurants")').first();
  if (await visible(confirm)) await confirm.click();
  result = { success: true, formattedAddress: String(args.address) };
} else if (op === "doordash_search") {
  const term = args.cuisine || args.query;
  const path = args.cuisine ? "/cuisine/" : "/search/store/";
  await page.goto(base + path + encodeURIComponent(String(term)), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  result = await page.locator('a[href*="/store/"]').evaluateAll((links) => {
    const seen = new Set();
    return links.map((link) => {
      const href = link.getAttribute("href") || "";
      const id = href.match(/\\/store\\/(?:[^/]+-)?(\\d+)/)?.[1] || href.match(/\\/store\\/([^/?]+)/)?.[1];
      const text = (link.textContent || "").replace(/\\s+/g, " ").trim();
      if (!id || seen.has(id) || text.length < 3) return null;
      seen.add(id);
      const rating = Number(text.match(/(\\d\\.\\d)\\s*\\(/)?.[1] || 0);
      const name = text.split(/\\d\\.\\d\\s*\\(/)[0].trim();
      return { id, name, rating, text, url: new URL(href, location.origin).href };
    }).filter(Boolean).slice(0, 20);
  });
  result = { success: true, restaurants: result };
} else if (op === "doordash_menu") {
  await page.goto(base + "/store/" + encodeURIComponent(String(args.restaurantId)), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const restaurant = (await page.locator("h1").first().innerText().catch(() => "")) || "Unknown Restaurant";
  const items = await page.locator('button, [role="button"], [data-testid*="MenuItem"], [data-testid*="item-card"]').evaluateAll((nodes, restaurantId) => {
    const seen = new Set();
    return nodes.map((node, index) => {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      const price = text.match(/\\$(\\d+(?:\\.\\d{1,2})?)/);
      const name = price ? text.slice(0, text.indexOf(price[0])).replace(/[-–—]\\s*$/, "").trim() : "";
      if (!price || name.length < 2 || seen.has(name)) return null;
      seen.add(name);
      return { id: restaurantId + "-" + index, name, price: Number(price[1]), description: text.slice(text.indexOf(price[0]) + price[0].length, 240).trim() };
    }).filter(Boolean).slice(0, 100);
  }, String(args.restaurantId));
  result = { success: true, restaurant: restaurant.trim(), categories: [{ name: "Menu", items }] };
} else if (op === "doordash_add_to_cart") {
  if (!page.url().includes("/store/" + String(args.restaurantId))) {
    await page.goto(base + "/store/" + encodeURIComponent(String(args.restaurantId)), { waitUntil: "domcontentloaded" });
  }
  const item = page.locator('button, [role="button"]').filter({ hasText: String(args.itemName) }).first();
  if (!(await visible(item, 8000))) throw new Error("DoorDash menu item was not found");
  await item.click();
  await page.waitForTimeout(1000);
  const quantity = Math.max(1, Math.min(99, Number(args.quantity || 1)));
  for (let index = 1; index < quantity; index += 1) {
    const plus = page.locator('button[aria-label*="increase" i], button:has-text("+")').first();
    if (!(await visible(plus))) throw new Error("DoorDash quantity control was not found");
    await plus.click();
  }
  if (args.specialInstructions) {
    const note = page.locator('textarea[placeholder*="instruction" i], input[placeholder*="instruction" i]').first();
    if (await visible(note)) await note.fill(String(args.specialInstructions));
  }
  const add = page.locator('button:has-text("Add to Cart"), button:has-text("Add to Order")').first();
  if (!(await visible(add, 5000))) throw new Error("DoorDash add-to-cart control was not found");
  await add.click();
  result = { success: true };
} else if (op === "doordash_cart" || op === "remove_from_cart") {
  const cartButton = page.locator('button[aria-label*="cart" i], button:has-text("Cart")').first();
  if (await visible(cartButton, 3000)) await cartButton.click();
  await page.waitForTimeout(800);
  const rows = page.locator('[data-testid*="cart" i] [role="group"], [data-testid*="cart" i] li, [aria-label*="cart" i] li');
  if (op === "remove_from_cart") {
    const index = Number(String(args.itemId).replace(/^item-/, ""));
    if (!Number.isInteger(index) || index < 0 || index >= await rows.count()) throw new Error("DoorDash cart item is no longer present");
    const remove = rows.nth(index).locator('button[aria-label*="remove" i], button:has-text("Remove")').first();
    if (!(await visible(remove))) throw new Error("DoorDash remove control was not found");
    await remove.click();
    result = { success: true, removed: String(args.itemId) };
  } else {
    const items = await rows.evaluateAll((nodes) => nodes.map((node, index) => ({ itemId: "item-" + index, name: (node.textContent || "").replace(/\\s+/g, " ").trim(), quantity: Number((node.textContent || "").match(/(?:Qty|Quantity|x)\\s*(\\d+)/i)?.[1] || 1), price: Number((node.textContent || "").match(/\\$(\\d+(?:\\.\\d{1,2})?)/)?.[1] || 0) })).filter((item) => item.name));
    const text = await bodyText();
    result = { success: true, cartId: "active", items, subtotal: money(text, "Subtotal"), total: money(text, "Total") };
  }
} else if (op === "order_history") {
  await page.goto(base + "/orders", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));
  const orders = await page.locator('a[href*="/orders/"]').evaluateAll((links, max) => links.slice(0, max).map((link) => ({ orderId: (link.getAttribute("href") || "").match(/\\/orders\\/([^/?]+)/)?.[1], summary: (link.textContent || "").replace(/\\s+/g, " ").trim(), url: new URL(link.getAttribute("href") || "", location.origin).href })), limit);
  result = { success: true, orders };
} else if (op === "doordash_checkout") {
  const checkout = page.locator('button:has-text("Checkout"), a:has-text("Checkout")').first();
  if (await visible(checkout, 3000)) await checkout.click();
  await page.waitForTimeout(1500);
  const text = await bodyText();
  const total = money(text, "Total");
  const deliveryAddress = text.match(/Deliver to[:\\s]*([^\\n$]+)/i)?.[1]?.trim() || "";
  const estimatedDelivery = text.match(/(\\d+[-–]\\d+\\s*min)/)?.[1] || "";
  const summary = { total, deliveryAddress, estimatedDelivery };
  if (!args.confirm) {
    result = { success: true, requiresConfirmation: true, summary };
  } else {
    const place = page.locator('button:has-text("Place Order")').first();
    if (!(await visible(place, 5000)) || !total || total <= 0) throw new Error("DoorDash checkout is not ready for authoritative submission");
    await place.click();
    await page.waitForURL(/\\/(?:orders?|order)\\//, { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const confirmationText = await bodyText();
    const orderId = page.url().match(/\\/(?:orders?|order)\\/([^/?#]+)/)?.[1];
    if (!orderId || !/(order|confirmed|preparing|delivery)/i.test(confirmationText)) throw new Error("DoorDash submission outcome is ambiguous; inspect the active session before retrying");
    result = { success: true, orderId, summary };
  }
} else if (op === "doordash_track_order") {
  await page.goto(base + "/orders" + (args.orderId ? "/" + encodeURIComponent(String(args.orderId)) : ""), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  if (!args.orderId) {
    const first = page.locator('a[href*="/orders/"]').first();
    if (await visible(first, 2000)) await first.click();
  }
  const text = await bodyText();
  const orderId = String(args.orderId || page.url().match(/\\/orders\\/([^/?#]+)/)?.[1] || "");
  const state = ["Delivered", "On the way", "Picking up", "Preparing"].find((candidate) => text.includes(candidate)) || "Unknown";
  result = { success: true, status: { orderId, status: state, estimatedDelivery: text.match(/(\\d+[-–]\\d+\\s*min)/)?.[1] || "", total: money(text, "Total") } };
} else {
  throw new Error("Unknown managed DoorDash tool: " + op);
}
JSON.stringify(result);
  `.trim();
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
      return { confirm: args.confirm === true };
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
  requireIdentity(auth);
  if (name === "doordash_auth_clear") return clearSession(auth);
  if (!DOORDASH_MANAGED_TOOLS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown managed DoorDash tool: ${name}`);
  }
  const validatedArgs = validateManagedArgs(name, args);

  const session = await getOrCreateSession(auth);
  if (name === "doordash_checkout" && validatedArgs.confirm === true) {
    const preview = await executeHostedBrowserCommand(
      session.id,
      {
        subaction: "eval",
        script: managedScript(name, { ...validatedArgs, confirm: false }),
        timeoutMs: 120_000,
      },
      auth,
    );
    const guardDigest = createHash("sha256")
      .update(`${identityHash(auth)}:${session.id}:${JSON.stringify(preview.output)}`)
      .digest("hex");
    await claimCheckout(auth, guardDigest);
  }

  const executed = await executeHostedBrowserCommand(
    session.id,
    {
      subaction: "eval",
      script: managedScript(name, validatedArgs),
      timeoutMs: 120_000,
    },
    auth,
  );
  const payload = executed.output;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DoorDash browser returned an invalid result");
  }
  const result = payload as Record<string, unknown>;
  if (name === "doordash_auth_check" && result.loggedIn !== true) {
    return {
      ...result,
      success: true,
      authRequired: true,
      loginUrl: session.interactiveLiveViewUrl ?? session.liveViewUrl ?? null,
      instructions:
        "Open loginUrl, sign in to DoorDash directly, then ask the agent to check DoorDash status again.",
    };
  }
  return { success: true, ...result };
}

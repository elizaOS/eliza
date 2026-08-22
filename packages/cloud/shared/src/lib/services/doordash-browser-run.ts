/**
 * Owns user-and-conversation-isolated DoorDash sessions on Cloudflare Browser Run.
 * The caller persists only opaque session IDs; credentials and cookies remain
 * inside Browser Run, while Live View provides an explicit human login handoff.
 */

import type { Browser, BrowserWorker, Page } from "@cloudflare/playwright";
import { getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { doorDashPersistentConnectOptions } from "./doordash-browser-run-session";
import { assertManagedCheckoutBinding } from "./doordash-checkout-binding";

const BASE_URL = "https://www.doordash.com";
const KEEP_ALIVE_MS = 600_000;
const LIVE_VIEW_TTL_MS = KEEP_ALIVE_MS;
const BROWSER_RUN_ENDPOINT = "https://browser.run.invalid";
const HUMAN_HANDOFF_INSTRUCTIONS =
  "Complete DoorDash security verification and sign in. Do not add items, check out, or place an order. Select Done when DoorDash is ready for the agent.";

async function browserRunSdk(): Promise<typeof import("@cloudflare/playwright")> {
  return await import("@cloudflare/playwright");
}

export interface DoorDashBrowserSession {
  readonly id: string;
  readonly interactiveLiveViewUrl: string;
}

interface DoorDashHumanHandoff {
  readonly humanInterventionRequired: true;
  readonly handoffId?: string;
  readonly handoffState: "active" | "manual";
}

function browserBinding(): BrowserWorker {
  const binding = getCloudBinding<BrowserWorker>("BROWSER");
  if (!binding) {
    throw new Error("Cloudflare Browser Run binding is unavailable");
  }
  return binding;
}

async function pageFor(browser: Browser): Promise<Page> {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Cloudflare Browser Run persistent context is unavailable");
  }
  return context.pages()[0] ?? (await context.newPage());
}

async function connectPersistentBrowser(
  binding: BrowserWorker,
  sessionId: string,
): Promise<Browser> {
  const { connect } = await browserRunSdk();
  return await connect(binding, doorDashPersistentConnectOptions(sessionId));
}

async function liveViewUrl(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const liveView = await cdp.send("Cloudflare.getLiveView", {
      mode: "tab",
      expiresInMs: LIVE_VIEW_TTL_MS,
    });
    return liveView.devtoolsFrontendUrl;
  } finally {
    await cdp.detach();
  }
}

async function ensureHumanHandoff(page: Page): Promise<DoorDashHumanHandoff> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const current = await cdp.send("Cloudflare.getHandoffState", {});
    if (current.active && current.handoffId) {
      return {
        humanInterventionRequired: true,
        handoffId: current.handoffId,
        handoffState: "active",
      };
    }
    const created = await cdp.send("Cloudflare.handoff", {
      instructions: HUMAN_HANDOFF_INSTRUCTIONS,
      timeout: KEEP_ALIVE_MS,
    });
    return {
      humanInterventionRequired: true,
      handoffId: created.handoffId,
      handoffState: "active",
    };
  } catch (error) {
    // error-policy:J4 Live View remains a usable, visibly manual fallback if
    // Browser Run's structured handoff control is temporarily unavailable.
    logger.warn(
      { error },
      "[DoorDashBrowserRun] Structured human handoff unavailable; using manual Live View",
    );
    return {
      humanInterventionRequired: true,
      handoffState: "manual",
    };
  } finally {
    await cdp.detach();
  }
}

async function disconnect(browser: Browser): Promise<void> {
  // A browser obtained through connect() disconnects without terminating the
  // Browser Run session, preserving the user's authenticated context.
  await browser.close();
}

export async function createDoorDashBrowserSession(): Promise<DoorDashBrowserSession> {
  const binding = browserBinding();
  const { acquire } = await browserRunSdk();
  const { sessionId } = await acquire(binding, {
    keep_alive: KEEP_ALIVE_MS,
    guardrails: {
      allowedDomains: [
        "doordash.com",
        "*.doordash.com",
        "*.google.com",
        "*.apple.com",
        "*.stripe.com",
        "*.braintreegateway.com",
      ],
      allowedDomainSets: ["common-cdns"],
    },
  });
  const browser = await connectPersistentBrowser(binding, sessionId);
  try {
    const page = await pageFor(browser);
    await page.goto(`${BASE_URL}/consumer/login`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    return { id: sessionId, interactiveLiveViewUrl: await liveViewUrl(page) };
  } catch (error) {
    await deleteDoorDashBrowserSession(sessionId).catch(() => {
      // error-policy:J6 creation failure is authoritative; cleanup is best effort.
    });
    throw error;
  } finally {
    await disconnect(browser).catch(() => {
      // error-policy:J6 the operation result remains authoritative during disconnect.
    });
  }
}

export async function getDoorDashBrowserSession(
  sessionId: string,
): Promise<DoorDashBrowserSession> {
  const browser = await connectPersistentBrowser(browserBinding(), sessionId);
  try {
    const page = await pageFor(browser);
    return { id: sessionId, interactiveLiveViewUrl: await liveViewUrl(page) };
  } finally {
    await disconnect(browser);
  }
}

export async function deleteDoorDashBrowserSession(sessionId: string): Promise<void> {
  const response = await browserBinding().fetch(
    `${BROWSER_RUN_ENDPOINT}/v1/devtools/browser/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Cloudflare Browser Run session deletion failed (${response.status})`);
  }
}

async function visible(locator: ReturnType<Page["locator"]>, timeout = 1_500): Promise<boolean> {
  return await locator.isVisible({ timeout }).catch(() => false);
}

async function bodyText(page: Page): Promise<string> {
  return await page
    .locator("body")
    .innerText()
    .catch(() => "");
}

async function hasDoorDashSecurityChallenge(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const text = (await bodyText(page)).toLowerCase();
  return (
    title.includes("just a moment") ||
    text.includes("performing security verification") ||
    text.includes("protect against malicious bots") ||
    text.includes("verify you are human")
  );
}

function money(text: string, label: string): number | null {
  const match = text.match(new RegExp(`${label}[:\\s]*\\$(\\d+(?:\\.\\d{1,2})?)`, "i"));
  return match ? Number(match[1]) : null;
}

async function runDoorDashOperation(
  page: Page,
  op: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (op === "doordash_auth_check") {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    if (await hasDoorDashSecurityChallenge(page)) {
      return {
        loggedIn: false,
        securityVerificationRequired: true,
        ...(await ensureHumanHandoff(page)),
        url: page.url(),
      };
    }
    const login = page
      .locator('a[href*="consumer/login"], button:has-text("Sign In"), a:has-text("Sign In")')
      .first();
    const account = page
      .locator(
        'a[href*="consumer/account"], a[href*="orders"], button[aria-label*="account" i], button[aria-label*="profile" i]',
      )
      .first();
    const loggedIn = await visible(account);
    return {
      loggedIn,
      loginVisible: await visible(login),
      ...(!loggedIn ? await ensureHumanHandoff(page) : {}),
      url: page.url(),
    };
  }
  if (op === "doordash_set_address") {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    const input = page
      .locator(
        'input[placeholder*="delivery address" i], input[placeholder*="enter delivery" i], [role="combobox"][aria-label*="address" i]',
      )
      .first();
    if (!(await visible(input, 5_000))) throw new Error("DoorDash address input was not found");
    await input.fill(String(args.address));
    await page.waitForTimeout(1_500);
    const suggestion = page.locator('[role="option"], [role="listbox"] button').first();
    if (!(await visible(suggestion, 3_000))) {
      throw new Error("DoorDash returned no address suggestion");
    }
    await suggestion.click();
    const confirm = page
      .locator(
        'button:has-text("Save"), button:has-text("Done"), button:has-text("Confirm"), button:has-text("Find Restaurants")',
      )
      .first();
    if (await visible(confirm)) await confirm.click();
    return { success: true, formattedAddress: String(args.address) };
  }
  if (op === "doordash_search") {
    const term = args.cuisine || args.query;
    const path = args.cuisine ? "/cuisine/" : "/search/store/";
    await page.goto(BASE_URL + path + encodeURIComponent(String(term)), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3_500);
    const restaurants = await page.locator('a[href*="/store/"]').evaluateAll((links) => {
      const seen = new Set<string>();
      return links
        .map((link) => {
          const href = link.getAttribute("href") || "";
          const id =
            href.match(/\/store\/(?:[^/]+-)?(\d+)/)?.[1] || href.match(/\/store\/([^/?]+)/)?.[1];
          const text = (link.textContent || "").replace(/\s+/g, " ").trim();
          if (!id || seen.has(id) || text.length < 3) return null;
          seen.add(id);
          const rating = Number(text.match(/(\d\.\d)\s*\(/)?.[1] || 0);
          const name = text.split(/\d\.\d\s*\(/)[0].trim();
          return { id, name, rating, text, url: new URL(href, location.origin).href };
        })
        .filter((entry) => entry !== null)
        .slice(0, 20);
    });
    return { success: true, restaurants };
  }
  if (op === "doordash_menu") {
    await page.goto(`${BASE_URL}/store/${encodeURIComponent(String(args.restaurantId))}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3_500);
    const restaurant =
      (await page
        .locator("h1")
        .first()
        .innerText()
        .catch(() => "")) || "Unknown Restaurant";
    const items = await page
      .locator('button, [role="button"], [data-testid*="MenuItem"], [data-testid*="item-card"]')
      .evaluateAll((nodes, restaurantId) => {
        const seen = new Set<string>();
        return nodes
          .map((node, index) => {
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            const price = text.match(/\$(\d+(?:\.\d{1,2})?)/);
            const name = price
              ? text
                  .slice(0, text.indexOf(price[0]))
                  .replace(/[-–—]\s*$/, "")
                  .trim()
              : "";
            if (!price || name.length < 2 || seen.has(name)) return null;
            seen.add(name);
            return {
              id: `${restaurantId}-${index}`,
              name,
              price: Number(price[1]),
              description: text.slice(text.indexOf(price[0]) + price[0].length, 240).trim(),
            };
          })
          .filter((entry) => entry !== null)
          .slice(0, 100);
      }, String(args.restaurantId));
    return { success: true, restaurant: restaurant.trim(), categories: [{ name: "Menu", items }] };
  }
  if (op === "doordash_add_to_cart") {
    if (!page.url().includes(`/store/${String(args.restaurantId)}`)) {
      await page.goto(`${BASE_URL}/store/${encodeURIComponent(String(args.restaurantId))}`, {
        waitUntil: "domcontentloaded",
      });
    }
    const item = page
      .locator('button, [role="button"]')
      .filter({ hasText: String(args.itemName) })
      .first();
    if (!(await visible(item, 8_000))) throw new Error("DoorDash menu item was not found");
    await item.click();
    await page.waitForTimeout(1_000);
    const quantity = Math.max(1, Math.min(99, Number(args.quantity || 1)));
    for (let index = 1; index < quantity; index += 1) {
      const plus = page.locator('button[aria-label*="increase" i], button:has-text("+")').first();
      if (!(await visible(plus))) throw new Error("DoorDash quantity control was not found");
      await plus.click();
    }
    if (args.specialInstructions) {
      const note = page
        .locator('textarea[placeholder*="instruction" i], input[placeholder*="instruction" i]')
        .first();
      if (await visible(note)) await note.fill(String(args.specialInstructions));
    }
    const add = page
      .locator('button:has-text("Add to Cart"), button:has-text("Add to Order")')
      .first();
    if (!(await visible(add, 5_000))) {
      throw new Error("DoorDash add-to-cart control was not found");
    }
    await add.click();
    return { success: true };
  }
  if (op === "doordash_cart" || op === "remove_from_cart") {
    const cartButton = page
      .locator('button[aria-label*="cart" i], button:has-text("Cart")')
      .first();
    if (await visible(cartButton, 3_000)) await cartButton.click();
    await page.waitForTimeout(800);
    const rows = page.locator(
      '[data-testid*="cart" i] [role="group"], [data-testid*="cart" i] li, [aria-label*="cart" i] li',
    );
    if (op === "remove_from_cart") {
      const index = Number(String(args.itemId).replace(/^item-/, ""));
      if (!Number.isInteger(index) || index < 0 || index >= (await rows.count())) {
        throw new Error("DoorDash cart item is no longer present");
      }
      const remove = rows
        .nth(index)
        .locator('button[aria-label*="remove" i], button:has-text("Remove")')
        .first();
      if (!(await visible(remove))) throw new Error("DoorDash remove control was not found");
      await remove.click();
      return { success: true, removed: String(args.itemId) };
    }
    const items = await rows.evaluateAll((nodes) =>
      nodes
        .map((node, index) => ({
          itemId: `item-${index}`,
          name: (node.textContent || "").replace(/\s+/g, " ").trim(),
          quantity: Number((node.textContent || "").match(/(?:Qty|Quantity|x)\s*(\d+)/i)?.[1] || 1),
          price: Number((node.textContent || "").match(/\$(\d+(?:\.\d{1,2})?)/)?.[1] || 0),
        }))
        .filter((item) => item.name),
    );
    const text = await bodyText(page);
    return {
      success: true,
      cartId: "active",
      items,
      subtotal: money(text, "Subtotal"),
      total: money(text, "Total"),
    };
  }
  if (op === "order_history") {
    await page.goto(`${BASE_URL}/orders`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));
    const orders = await page.locator('a[href*="/orders/"]').evaluateAll(
      (links, maximum) =>
        links.slice(0, maximum).map((link) => ({
          orderId: (link.getAttribute("href") || "").match(/\/orders\/([^/?]+)/)?.[1],
          summary: (link.textContent || "").replace(/\s+/g, " ").trim(),
          url: new URL(link.getAttribute("href") || "", location.origin).href,
        })),
      limit,
    );
    return { success: true, orders };
  }
  if (op === "doordash_checkout") {
    const checkout = page.locator('button:has-text("Checkout"), a:has-text("Checkout")').first();
    if (await visible(checkout, 3_000)) await checkout.click();
    await page.waitForTimeout(1_500);
    const text = await bodyText(page);
    const total = money(text, "Total");
    const deliveryAddress = text.match(/Deliver to[:\s]*([^\n$]+)/i)?.[1]?.trim() || "";
    const estimatedDelivery = text.match(/(\d+[-–]\d+\s*min)/)?.[1] || "";
    const summary = { total, deliveryAddress, estimatedDelivery };
    if (!args.confirm) return { success: true, requiresConfirmation: true, summary };
    const place = page.locator('button:has-text("Place Order")').first();
    if (!(await visible(place, 5_000)) || !total || total <= 0) {
      throw new Error("DoorDash checkout is not ready for authoritative submission");
    }
    await place.click();
    await page.waitForURL(/\/(?:orders?|order)\//, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const confirmationText = await bodyText(page);
    const orderId = page.url().match(/\/(?:orders?|order)\/([^/?#]+)/)?.[1];
    if (!orderId || !/(order|confirmed|preparing|delivery)/i.test(confirmationText)) {
      throw new Error(
        "DoorDash submission outcome is ambiguous; inspect the active session before retrying",
      );
    }
    return { success: true, orderId, summary };
  }
  if (op === "doordash_track_order") {
    await page.goto(
      `${BASE_URL}/orders${args.orderId ? `/${encodeURIComponent(String(args.orderId))}` : ""}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(1_800);
    if (!args.orderId) {
      const first = page.locator('a[href*="/orders/"]').first();
      if (await visible(first, 2_000)) await first.click();
    }
    const text = await bodyText(page);
    const orderId = String(args.orderId || page.url().match(/\/orders\/([^/?#]+)/)?.[1] || "");
    const status =
      ["Delivered", "On the way", "Picking up", "Preparing"].find((state) =>
        text.includes(state),
      ) || "Unknown";
    return {
      success: true,
      status: {
        orderId,
        status,
        estimatedDelivery: text.match(/(\d+[-–]\d+\s*min)/)?.[1] || "",
        total: money(text, "Total"),
      },
    };
  }
  throw new Error(`Unknown managed DoorDash tool: ${op}`);
}

export async function executeDoorDashBrowserOperation(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const browser = await connectPersistentBrowser(browserBinding(), sessionId);
  try {
    const page = await pageFor(browser);
    if (name !== "doordash_auth_check" && (await hasDoorDashSecurityChallenge(page))) {
      throw new Error(
        "DoorDash requires human security verification in the active Cloudflare Live View",
      );
    }
    let result: Record<string, unknown>;
    if (name === "doordash_checkout" && args.confirm === true) {
      const cart = await runDoorDashOperation(page, "doordash_cart", {});
      const preview = await runDoorDashOperation(page, name, {
        confirm: false,
      });
      assertManagedCheckoutBinding(args.expectedCheckoutDigest, cart, preview);
      result = await runDoorDashOperation(page, name, args);
    } else {
      result = await runDoorDashOperation(page, name, args);
    }
    if (name !== "doordash_auth_check" && (await hasDoorDashSecurityChallenge(page))) {
      throw new Error(
        "DoorDash requires human security verification in the active Cloudflare Live View",
      );
    }
    return result;
  } finally {
    await disconnect(browser);
  }
}

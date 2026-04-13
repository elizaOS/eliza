import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../../../test/helpers/conditional-tests.ts";

const DEFAULT_UI_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_UI_URL ??
    process.env.ELIZA_UI_URL ??
    "http://127.0.0.1:2138",
);
const DEFAULT_API_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_API_URL ??
    process.env.ELIZA_API_URL ??
    "http://127.0.0.1:31337",
);
const API_TOKEN =
  process.env.ELIZA_API_TOKEN?.trim() ??
  process.env.ELIZA_API_TOKEN?.trim() ??
  "";
const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const CHROME_AVAILABLE = existsSync(CHROME_PATH);
const ARTIFACT_DIR = path.resolve(
  import.meta.dirname,
  "../../../../.tmp/live-memory-relationships-e2e",
);

type MemoryStatsResponse = {
  total: number;
  byType: Record<string, number>;
};

type MemoryBrowseResponse = {
  memories: Array<{
    id: string;
    text: string;
  }>;
  total: number;
  limit: number;
  offset: number;
};

type RelationshipsPersonSummary = {
  primaryEntityId: string;
  memberEntityIds: string[];
  displayName: string;
};

type RelationshipsPeopleResponse = {
  data: RelationshipsPersonSummary[];
  stats: {
    totalPeople: number;
    totalRelationships: number;
    totalIdentities: number;
  };
};

type RelationshipsActivityResponse = {
  count: number;
  activity: Array<{
    type: "relationship" | "identity" | "fact";
    summary: string;
    detail: string | null;
  }>;
};

let browser: Browser | null = null;
const uiUrl = DEFAULT_UI_URL;
const apiUrl = DEFAULT_API_URL;

const describeLive = describeIf(LIVE_TESTS_ENABLED && CHROME_AVAILABLE);

if (LIVE_TESTS_ENABLED && !CHROME_AVAILABLE) {
  console.info(
    `[live-memory-relationships] Chrome not found at ${CHROME_PATH}; suite unavailable until a real browser is installed there or ELIZA_CHROME_PATH is set.`,
  );
}

describeLive("Live memory + relationships browser E2E", () => {
  beforeAll(async () => {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    await ensureHttpOk(`${uiUrl}/`);
    await ensureHttpOk(`${apiUrl}/api/status`);
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      protocolTimeout: 180_000,
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--use-angle=swiftshader",
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("verifies the live memories view, search flow, and person filtering", async () => {
    const activeBrowser = ensureBrowser(browser);
    const page = await activeBrowser.newPage();
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(60_000);
    await configureLivePage(page);

    const token = `live-e2e-memory-${crypto.randomUUID()}`;
    const rememberResponse = await apiJson<{ ok: boolean; text: string }>(
      "/api/memory/remember",
      {
        method: "POST",
        body: JSON.stringify({ text: token }),
      },
    );
    expect(rememberResponse.ok).toBe(true);
    expect(rememberResponse.text).toBe(token);

    const stats = await apiJson<MemoryStatsResponse>("/api/memories/stats");
    expect(stats.total).toBeGreaterThan(0);

    await navigate(page, `${uiUrl}/memories`);
    await waitForText(page, "Memories");
    await waitForText(page, token, 45_000);

    const initialBody = await bodyText(page);
    expect(initialBody).toContain(String(stats.total));
    expect(initialBody).not.toContain("(empty)");

    await clickByText(page, "Browse");
    await typeInto(page, '[data-testid="memory-browser-search"]', token);
    await waitForText(page, token, 30_000);

    const searchResult = await apiJson<MemoryBrowseResponse>(
      `/api/memories/browse?q=${encodeURIComponent(token)}&limit=10`,
    );
    expect(searchResult.total).toBeGreaterThanOrEqual(1);

    const people = await apiJson<RelationshipsPeopleResponse>(
      "/api/relationships/people?limit=200",
    );
    const candidate = await findPersonWithMemories(people.data, stats.total);
    expect(candidate).not.toBeNull();
    if (!candidate) {
      throw new Error("No live person with scoped memories was found.");
    }

    await typeInto(
      page,
      'input[aria-label="Search people"]',
      candidate.person.displayName,
    );
    await clickSidebarItem(page, candidate.person.displayName);
    await waitForText(page, "Filtered to", 30_000);
    await waitForText(page, candidate.person.displayName, 30_000);
    await waitForSummaryTotal(page, candidate.total, 30_000);

    const filteredBody = await bodyText(page);
    expect(filteredBody).toContain(`of ${candidate.total}`);
    if (candidate.total < stats.total) {
      expect(filteredBody).not.toContain(`of ${stats.total}`);
    }

    await saveScreenshot(page, "memories-live");
    await page.close();
  }, 180_000);

  it("verifies the live relationships activity panel against the backend", async () => {
    const activeBrowser = ensureBrowser(browser);
    const page = await activeBrowser.newPage();
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(60_000);
    await configureLivePage(page);

    const stats = await apiJson<MemoryStatsResponse>("/api/memories/stats");
    const activity = await apiJson<RelationshipsActivityResponse>(
      "/api/relationships/activity?limit=10",
    );

    await navigate(page, `${uiUrl}/relationships`);
    await waitForText(page, "Relationships");
    await waitForText(page, "Recent relationship, identity, and fact events");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    if (activity.activity.length === 0) {
      await waitForText(
        page,
        "No relationship activity yet. Events will appear as the agent extracts relationships, identities, and facts from conversations.",
      );
    } else {
      const firstSummary = activity.activity[0]?.summary;
      if (!firstSummary) {
        throw new Error("Expected a live activity item summary.");
      }
      await waitForText(page, firstSummary, 30_000);
      expect(activity.count).toBeGreaterThanOrEqual(activity.activity.length);
      expect(
        activity.activity.every((item) =>
          ["relationship", "identity", "fact"].includes(item.type),
        ),
      ).toBe(true);
    }

    if (stats.byType.facts > 0) {
      const factItem = activity.activity.find((item) => item.type === "fact");
      expect(factItem).toBeDefined();
      if (factItem) {
        await waitForText(page, factItem.summary, 30_000);
      }
    }

    await saveScreenshot(page, "relationships-live");
    await page.close();
  }, 180_000);
});

function ensureBrowser(current: Browser | null): Browser {
  if (!current) {
    throw new Error("Browser was not initialized.");
  }
  return current;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function ensureHttpOk(url: string): Promise<void> {
  const response = await fetch(url, {
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Expected ${url} to be reachable, got ${response.status}.`);
  }
}

async function apiJson<T>(route: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (API_TOKEN) {
    headers.set("authorization", `Bearer ${API_TOKEN}`);
  }
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`API ${route} failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function configureLivePage(page: Page): Promise<void> {
  await page.setViewport({ width: 1440, height: 1000 });
  if (API_TOKEN) {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${API_TOKEN}`,
    });
  }
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("eliza:onboarding-complete", "1");
    localStorage.setItem("eliza:onboarding:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem(
      "eliza:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
  });
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !window.location.pathname.includes("/onboarding"),
    { timeout: 60_000 },
  );
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 60_000 });
}

async function waitForText(
  page: Page,
  text: string,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout },
    text,
  );
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function typeInto(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const input = await page.waitForSelector(selector, { visible: true });
  if (!input) {
    throw new Error(`Input ${selector} was not found.`);
  }
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(value);
}

async function clickByText(
  page: Page,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await page.waitForFunction(
    ({ expected, root }) => {
      const scope = document.querySelector(root) ?? document.body;
      const nodes = Array.from(scope.querySelectorAll("*"));
      return nodes.some((node) => {
        const label = node.textContent?.trim();
        if (label !== expected) return false;
        return Boolean(node.closest("button,[role='button'],a"));
      });
    },
    { timeout: 20_000 },
    { expected: text, root: rootSelector },
  );

  const clicked = await page.evaluate(
    ({ expected, root }) => {
      const scope = document.querySelector(root) ?? document.body;
      const nodes = Array.from(scope.querySelectorAll("*"));
      for (const node of nodes) {
        const label = node.textContent?.trim();
        if (label !== expected) continue;
        const target = node.closest("button,[role='button'],a") ?? node;
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "center" });
          target.click();
          return true;
        }
      }
      return false;
    },
    { expected: text, root: rootSelector },
  );

  expect(clicked).toBe(true);
}

async function clickSidebarItem(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate((expected) => {
    const sidebar = document.querySelector(
      '[data-testid="memory-viewer-sidebar"]',
    );
    if (!sidebar) return false;
    const nodes = Array.from(sidebar.querySelectorAll("*"));
    for (const node of nodes) {
      const label = node.textContent?.trim();
      if (label !== expected) continue;
      const target = node.closest("button,[role='button'],a") ?? node;
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: "center" });
        target.click();
        return true;
      }
    }
    return false;
  }, text);
  expect(clicked).toBe(true);
}

async function waitForSummaryTotal(
  page: Page,
  total: number,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (expectedTotal) => {
      const text = document.body.innerText;
      const match = text.match(/\d+–\d+ of (\d+)/);
      return match
        ? Number.parseInt(match[1] ?? "", 10) === expectedTotal
        : false;
    },
    { timeout },
    total,
  );
}

async function findPersonWithMemories(
  people: RelationshipsPersonSummary[],
  globalTotal: number,
): Promise<{ person: RelationshipsPersonSummary; total: number } | null> {
  for (const person of people) {
    const qs = new URLSearchParams();
    if (person.memberEntityIds.length > 0) {
      qs.set("entityIds", person.memberEntityIds.join(","));
    }
    qs.set("limit", "1");
    const result = await apiJson<MemoryBrowseResponse>(
      `/api/memories/by-entity/${encodeURIComponent(person.primaryEntityId)}?${qs.toString()}`,
    );
    if (result.total > 0 && result.total < globalTotal) {
      return { person, total: result.total };
    }
  }

  for (const person of people) {
    const qs = new URLSearchParams();
    if (person.memberEntityIds.length > 0) {
      qs.set("entityIds", person.memberEntityIds.join(","));
    }
    qs.set("limit", "1");
    const result = await apiJson<MemoryBrowseResponse>(
      `/api/memories/by-entity/${encodeURIComponent(person.primaryEntityId)}?${qs.toString()}`,
    );
    if (result.total > 0) {
      return { person, total: result.total };
    }
  }

  return null;
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, `${name}.png`),
    fullPage: true,
  });
}

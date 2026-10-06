/** Real Clock renderer with a controlled native boundary; no actual native dispatch or model call. */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import type {
  ClockHost,
  ClockProposal,
} from "../../../ui/src/bridge/clock-host";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const bridgeUrl = `/@fs${path.join(repoRoot, "packages/ui/src/bridge/clock-host.ts")}`;
type Scenario =
  | "owned"
  | "receipt"
  | "expired"
  | "unsupported"
  | "read-failure"
  | "deferred";
interface Diagnostics {
  reviewCalls: {
    id: string;
    scope: string;
    state: string;
    operation: unknown;
  }[];
  dispatchCount: number;
  aborted: number;
  statusCalls: number;
  proposalCalls: number;
}
interface ControlledBoundary {
  diagnostics(): Diagnostics;
  changeOwner(): void;
}

async function capture(page: Page, state: string, receiptButton?: Locator) {
  const directory = testOutputPath(
    "clock-completion",
    "controlled-native-boundary",
  );
  await mkdir(directory, { recursive: true });
  if (receiptButton) {
    // Use ordinary DOM scrolling, preserving the fixed composer and viewport.
    await receiptButton.evaluate((element) =>
      element.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      }),
    );
    const composer = page.getByRole("group", {
      name: "Chat composer",
      exact: true,
    });
    await expect
      .poll(
        async () => {
          const button = await receiptButton.boundingBox();
          const panel = await composer.boundingBox();
          const viewport = page.viewportSize();
          return Boolean(
            button &&
              panel &&
              viewport &&
              button.x >= 0 &&
              button.y >= 0 &&
              button.x + button.width <= viewport.width &&
              button.y + button.height <= panel.y - 8,
          );
        },
        {
          message:
            "Saved receipt button must be fully above and clear of the fixed composer",
        },
      )
      .toBe(true);
  } else {
    const proposals = page.getByRole("region", {
      name: "Clock proposals",
      exact: true,
    });
    if (await proposals.count()) await proposals.scrollIntoViewIfNeeded();
  }
  await page.screenshot({
    path: `${directory}/${state}.png`,
    fullPage: true,
  });
}

async function diagnostics(page: Page): Promise<Diagnostics> {
  return page.evaluate(() => {
    const boundary = (
      window as typeof window & {
        __clockHostUiBoundary: ControlledBoundary;
      }
    ).__clockHostUiBoundary;
    return boundary.diagnostics();
  });
}

async function openControlledClock(page: Page, scenario: Scenario) {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  const effects: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/api\/(?:client-devices|lifeops\/reminders|chat|conversations.*messages)/.test(
        request.url(),
      )
    )
      effects.push(request.url());
  });
  await openAppPath(page, "/clock");
  await expect(
    page.getByRole("heading", { name: "Android alarm", exact: true }),
  ).toBeVisible();
  // Load the same real bridge module used by ClockView. The controlled host is
  // configured solely from this browser test, without a production test hook.
  await page.evaluate(
    async ({ url, scenario }) => {
      const bridge = await import(url);
      if (bridge.getClockHost() !== null)
        throw new Error("Expected an isolated web Clock host");
      let scope = "a".repeat(64);
      let proposal: ClockProposal | null = {
        id: "controlled-owned-clock",
        digest: "d".repeat(64),
        state: "pending",
        expiresAt: new Date(
          Date.now() + (scenario === "expired" ? -60_000 : 600_000),
        ).toISOString(),
        operation: {
          type: "clock_handoff",
          action: "set",
          hour: 9,
          minute: 0,
          label: "Controlled morning alarm",
          timeZone: "America/Los_Angeles",
          days: [1, 2, 3, 4, 5, 6, 7],
        },
      };
      const expectedOperation = JSON.stringify(proposal.operation);
      const listeners = new Set<() => void>();
      const counts: Diagnostics = {
        reviewCalls: [],
        dispatchCount: 0,
        aborted: 0,
        statusCalls: 0,
        proposalCalls: 0,
      };
      const host: ClockHost = {
        async status() {
          counts.statusCalls++;
          if (scenario === "read-failure")
            throw new Error("Controlled native boundary read failed");
          return {
            supported: true,
            agentBase: "http://127.0.0.1:31467",
            reason: null,
            capabilities: [
              scenario === "unsupported"
                ? "clock.handoff.v1"
                : "clock.handoff.v2",
            ],
            scope,
            installationId: "controlled-installation",
            context: {
              sensitive: false,
              revision: 1,
              timeZone: "America/Los_Angeles",
            },
          };
        },
        async proposals() {
          counts.proposalCalls++;
          return {
            scope,
            proposals: proposal ? [structuredClone(proposal)] : [],
          };
        },
        async review(request, ownerScope, signal) {
          if (
            ownerScope !== scope ||
            request.id !== proposal?.id ||
            JSON.stringify(request.operation) !== expectedOperation
          ) {
            throw new Error("Controlled proposal owner or operation changed");
          }
          counts.reviewCalls.push({
            id: request.id,
            scope: ownerScope,
            state: request.state,
            operation: structuredClone(request.operation),
          });
          if (scenario === "deferred") {
            return new Promise((_, reject) => {
              const abort = () => {
                counts.aborted++;
                reject(new Error("Controlled review retired"));
              };
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          }
          // Model the native boundary's retained receipt: terminal-state checks
          // settle the original outcome and never count as another dispatch.
          if (["pending", "approved"].includes(request.state))
            counts.dispatchCount++;
          proposal = { ...request, state: "done" };
          return {
            handoff: {
              kind: "clock-handoff",
              action: "set",
              status: scenario === "receipt" ? "unknown" : "opened",
            },
            receiptPending:
              scenario === "receipt" && counts.reviewCalls.length === 1,
          };
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async retire() {},
      };
      (
        window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
      ).__clockHostUiBoundary = {
        diagnostics: () => structuredClone(counts),
        changeOwner: () => {
          scope = "b".repeat(64);
          proposal = null;
          for (const listener of listeners) listener();
        },
      };
      bridge.configureClockHost(host);
    },
    { url: bridgeUrl, scenario },
  );
  return effects;
}

test("owned pending Clock proposal reaches the controlled native review boundary", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "owned");
  const section = page.getByRole("region", {
    name: "Clock proposals",
    exact: true,
  });
  await expect(section).toContainText("09:00 Controlled morning alarm");
  await expect(section).toContainText(
    "Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday",
  );
  await capture(page, "owned-pending");
  await section
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Android Clock opened. Check the installed alarm there; ringing is not confirmed.",
  );
  const actual = await diagnostics(page);
  expect(actual.dispatchCount).toBe(1);
  expect(actual.reviewCalls).toEqual([
    {
      id: "controlled-owned-clock",
      scope: "a".repeat(64),
      state: "pending",
      operation: {
        type: "clock_handoff",
        action: "set",
        hour: 9,
        minute: 0,
        label: "Controlled morning alarm",
        timeZone: "America/Los_Angeles",
        days: [1, 2, 3, 4, 5, 6, 7],
      },
    },
  ]);
  expect(effects).toEqual([]);
  await capture(page, "owned-reviewed");
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`UNKNOWN Clock receipt remains retryable after done on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const effects = await openControlledClock(page, "receipt");
    await page
      .getByRole("button", { name: "Review on this phone", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Clock result: unknown; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.",
    );
    const retry = page.getByRole("button", {
      name: "Check saved receipt",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await expect(
      page.getByText("No pending Clock requests.", { exact: false }),
    ).toHaveCount(0);
    await capture(page, `unknown-receipt-pending-${viewport.name}`, retry);
    await retry.click();
    await expect(page.getByRole("status")).toHaveText(
      "Clock result: unknown. No installed or ringing alarm is confirmed.",
    );
    const actual = await diagnostics(page);
    expect(actual.reviewCalls.map((call) => call.state)).toEqual([
      "pending",
      "done",
    ]);
    expect(actual.reviewCalls.map((call) => call.id)).toEqual([
      "controlled-owned-clock",
      "controlled-owned-clock",
    ]);
    expect(actual.dispatchCount).toBe(1);
    expect(effects).toEqual([]);
    await capture(page, `unknown-receipt-settled-${viewport.name}`, retry);
  });
}

test("expired pending Clock proposal cannot begin a native review", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "expired");
  await expect(
    page.getByText("Request expired. Send a new request in chat.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toBeDisabled();
  expect((await diagnostics(page)).reviewCalls).toEqual([]);
  expect(effects).toEqual([]);
  await capture(page, "expired-pending");
});

test("Clock host read failure remains a visible error", async ({ page }) => {
  const effects = await openControlledClock(page, "read-failure");
  await expect(page.getByRole("alert")).toHaveText(
    "Controlled native boundary read failed",
  );
  await expect(
    page.getByRole("region", { name: "Clock proposals", exact: true }),
  ).toHaveCount(0);
  const actual = await diagnostics(page);
  expect(actual.statusCalls).toBeGreaterThan(0);
  expect(actual.proposalCalls).toBe(0);
  expect(actual.reviewCalls).toEqual([]);
  expect(effects).toEqual([]);
  await capture(page, "read-failure");
});

test("a v1-only Clock host cannot review explicit repeat days", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "unsupported");
  await expect(
    page.getByText("This request requires newer Clock support on this phone.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toBeDisabled();
  const actual = await diagnostics(page);
  expect(actual.reviewCalls).toEqual([]);
  expect(actual.dispatchCount).toBe(0);
  expect(effects).toEqual([]);
  await capture(page, "v1-explicit-repeat-unsupported");
});

test("Clock unmount aborts an active controlled native review", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "deferred");
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Waiting for phone approval…",
      exact: true,
    }),
  ).toBeDisabled();
  await capture(page, "unmount-review-waiting");
  await page
    .getByRole("button", { name: "Manage reminders", exact: true })
    .click();
  await expect(page).toHaveURL(/\/automations/);
  await expect.poll(async () => (await diagnostics(page)).aborted).toBe(1);
  expect((await diagnostics(page)).dispatchCount).toBe(0);
  expect(effects).toEqual([]);
  await capture(page, "unmount-review-cancelled");
});

test("Clock owner scope change aborts an active controlled native review", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "deferred");
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Waiting for phone approval…",
      exact: true,
    }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.changeOwner();
  });
  await expect.poll(async () => (await diagnostics(page)).aborted).toBe(1);
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Waiting for phone approval…",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "No pending Clock requests. Send your request in chat to create one.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await diagnostics(page)).dispatchCount).toBe(0);
  expect(effects).toEqual([]);
  await capture(page, "owner-change-review-cancelled");
});

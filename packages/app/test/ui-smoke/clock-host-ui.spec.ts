/** Real Clock renderer with a controlled native boundary; no actual native dispatch or model call. */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClockAlarmOperation,
  ClockAlarmRecord,
} from "@elizaos/plugin-assistant/device-clock-review";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { createServer } from "vite";

import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import type {
  ClockAlarmStatus,
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
// This controlled-host contract imports the production bridge source. Serve the
// whole renderer from the same Vite graph so that import and ClockView share
// one registry; a dist server cannot serve /@fs or share its bundled singleton.
const test = base.extend<object, { clockRendererUrl: string }>({
  clockRendererUrl: [
    async ({ browserName: _browserName }, use) => {
      const server = await createServer({
        root: path.join(repoRoot, "packages/app"),
        configFile: path.join(repoRoot, "packages/app/vite.config.ts"),
        server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
      });
      try {
        await server.listen();
        const url = server.resolvedUrls?.local[0];
        if (!url) throw new Error("Clock renderer fixture did not bind a URL");
        await use(url);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ clockRendererUrl }, use) => {
    await use(clockRendererUrl);
  },
});
test.use({ timezoneId: "America/Los_Angeles" });
type Scenario =
  | "owned"
  | "receipt"
  | "expired"
  | "unsupported"
  | "read-failure"
  | "opened-refresh-failure"
  | "receipt-refresh-failure"
  | "receipt-owner-refresh-failure"
  | "receipt-reconcile-failure"
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
  loseOwner(): void;
  notifyForeground(): void;
  recoverForeground(notify: boolean): void;
}

async function capture(page: Page, state: string, receiptButton?: Locator) {
  const directory = testOutputPath(
    "clock-settled-refresh",
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
    page.getByRole("heading", { name: "Alarms", exact: true }),
  ).toBeVisible();
  // Load the same real bridge module used by ClockView. The controlled host is
  // configured solely from this browser test, without a production test hook.
  await page.evaluate(
    async ({ url, scenario }) => {
      const bridge = await import(url);
      if (bridge.getClockHost() !== null)
        throw new Error("Expected an isolated web Clock host");
      let scope = "a".repeat(64);
      let ownerUnavailable = false;
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
      let foregroundReadRejected = false;
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
          if (
            scenario === "receipt-owner-refresh-failure" &&
            foregroundReadRejected
          )
            throw new Error("Controlled native owner status unavailable");
          if (ownerUnavailable)
            return {
              supported: false,
              agentBase: null,
              reason: "Controlled native owner is unavailable",
              capabilities: [],
              scope: null,
              installationId: null,
              context: null,
            };
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
          if (foregroundReadRejected)
            throw new Error(
              "Controlled native foreground paused during refresh",
            );
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
          if (
            scenario === "receipt-reconcile-failure" &&
            counts.reviewCalls.length === 2
          )
            throw new Error("Controlled saved receipt reconciliation failed");
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
          foregroundReadRejected = [
            "opened-refresh-failure",
            "receipt-refresh-failure",
            "receipt-owner-refresh-failure",
          ].includes(scenario);
          return {
            handoff: {
              kind: "clock-handoff",
              action: "set",
              status: [
                "receipt",
                "receipt-refresh-failure",
                "receipt-owner-refresh-failure",
                "receipt-reconcile-failure",
              ].includes(scenario)
                ? "unknown"
                : "opened",
            },
            receiptPending:
              [
                "receipt",
                "receipt-refresh-failure",
                "receipt-owner-refresh-failure",
                "receipt-reconcile-failure",
              ].includes(scenario) && counts.reviewCalls.length === 1,
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
          ownerUnavailable = false;
          foregroundReadRejected = false;
          scope = "b".repeat(64);
          proposal = null;
          for (const listener of listeners) listener();
        },
        loseOwner: () => {
          ownerUnavailable = true;
          for (const listener of listeners) listener();
        },
        recoverForeground: (notify) => {
          foregroundReadRejected = false;
          if (notify) for (const listener of listeners) listener();
        },
        notifyForeground: () => {
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
  test(`settled OPENED Clock handoff survives failed proposal refresh and foreground resume on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const effects = await openControlledClock(page, "opened-refresh-failure");
    await expect(
      page.getByRole("button", { name: "Review on this phone", exact: true }),
    ).toBeEnabled();
    const before = await diagnostics(page);
    await page
      .getByRole("button", { name: "Review on this phone", exact: true })
      .click();
    const savedOutcome =
      "Android Clock opened. Check the installed alarm there; ringing is not confirmed.";
    await expect(page.getByRole("status")).toHaveText(savedOutcome);
    const settled = await diagnostics(page);
    expect(settled.statusCalls).toBe(before.statusCalls);
    expect(settled.proposalCalls).toBe(before.proposalCalls);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The actual visibility boundary suppresses reads while the phone is away
    // in external Clock; its return requests an owned read, never a dispatch.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      (
        window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
      ).__clockHostUiBoundary.notifyForeground();
    });
    expect((await diagnostics(page)).statusCalls).toBe(settled.statusCalls);
    expect((await diagnostics(page)).proposalCalls).toBe(settled.proposalCalls);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("alert")).toHaveText(
      "Clock requests could not be refreshed. Controlled native foreground paused during refresh",
    );
    await expect(
      page.getByRole("button", { name: "Review on this phone", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check saved receipt", exact: true }),
    ).toHaveCount(0);
    const paused = await diagnostics(page);
    expect(paused.dispatchCount).toBe(1);
    expect(paused.reviewCalls.map((call) => call.state)).toEqual(["pending"]);
    expect(effects).toEqual([]);
    await capture(page, `opened-refresh-failed-${viewport.name}`);

    await page.evaluate(() => {
      (
        window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
      ).__clockHostUiBoundary.recoverForeground(false);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(savedOutcome);
    await expect(
      page.getByRole("button", { name: "Review on this phone", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check saved receipt", exact: true }),
    ).toHaveCount(0);
    const resumed = await diagnostics(page);
    expect(resumed.statusCalls).toBeGreaterThan(paused.statusCalls);
    expect(resumed.proposalCalls).toBeGreaterThan(paused.proposalCalls);
    expect(resumed.reviewCalls).toEqual(paused.reviewCalls);
    expect(resumed.dispatchCount).toBe(1);
    expect(effects).toEqual([]);
    await capture(page, `opened-foreground-resumed-${viewport.name}`);
  });

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
      "reconciliation_required",
    ]);
    expect(actual.reviewCalls.map((call) => call.id)).toEqual([
      "controlled-owned-clock",
      "controlled-owned-clock",
    ]);
    expect(actual.dispatchCount).toBe(1);
    expect(effects).toEqual([]);
    await expect(retry).toHaveCount(0);
    await capture(page, `unknown-receipt-settled-${viewport.name}`);
  });
}

test("pending UNKNOWN receipt remains reconcilable after proposal refresh rejection", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "receipt-refresh-failure");
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toBeEnabled();
  const before = await diagnostics(page);
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Clock result: unknown; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.",
  );
  const settled = await diagnostics(page);
  expect(settled.statusCalls).toBe(before.statusCalls);
  expect(settled.proposalCalls).toBe(before.proposalCalls);
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.notifyForeground();
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Clock requests could not be refreshed. Controlled native foreground paused during refresh",
  );
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  const receipt = page.getByRole("button", {
    name: "Check saved receipt",
    exact: true,
  });
  await expect(receipt).toBeEnabled();
  await capture(page, "unknown-refresh-failed", receipt);
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.recoverForeground(true);
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(receipt).toBeEnabled();
  expect((await diagnostics(page)).dispatchCount).toBe(1);
  await receipt.click();
  await expect(page.getByRole("status")).toHaveText(
    "Clock result: unknown. No installed or ringing alarm is confirmed.",
  );
  const actual = await diagnostics(page);
  expect(actual.reviewCalls.map((call) => call.state)).toEqual([
    "pending",
    "reconciliation_required",
  ]);
  expect(actual.reviewCalls.map((call) => call.id)).toEqual([
    "controlled-owned-clock",
    "controlled-owned-clock",
  ]);
  expect(actual.dispatchCount).toBe(1);
  expect(effects).toEqual([]);
  await expect(receipt).toHaveCount(0);
  await capture(page, "unknown-refresh-reconciled");
});

test("saved UNKNOWN receipt waits for verified owner after status read rejection", async ({
  page,
}) => {
  const effects = await openControlledClock(
    page,
    "receipt-owner-refresh-failure",
  );
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  const pendingOutcome =
    "Clock result: unknown; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.";
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  const before = await diagnostics(page);
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.notifyForeground();
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Clock requests could not be refreshed. Controlled native owner status unavailable",
  );
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  const receipt = page.getByRole("button", {
    name: "Check saved receipt",
    exact: true,
  });
  await expect(receipt).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  const failed = await diagnostics(page);
  expect(failed.proposalCalls).toBe(before.proposalCalls);
  expect(failed.reviewCalls).toEqual(before.reviewCalls);
  expect(failed.dispatchCount).toBe(1);
  await capture(page, "unknown-owner-unverified", receipt);
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.recoverForeground(true);
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(receipt).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  expect((await diagnostics(page)).reviewCalls).toEqual(before.reviewCalls);
  await receipt.click();
  await expect(page.getByRole("status")).toHaveText(
    "Clock result: unknown. No installed or ringing alarm is confirmed.",
  );
  await expect(receipt).toHaveCount(0);
  const actual = await diagnostics(page);
  expect(actual.reviewCalls.map((call) => call.state)).toEqual([
    "pending",
    "reconciliation_required",
  ]);
  expect(actual.dispatchCount).toBe(1);
  expect(effects).toEqual([]);
  await capture(page, "unknown-owner-restored-reconciled");
});

test("validated unavailable Clock owner clears saved receipt and outcome before a new scope", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "receipt");
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  const pendingOutcome =
    "Clock result: unknown; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.";
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  await expect(
    page.getByRole("button", { name: "Check saved receipt", exact: true }),
  ).toBeEnabled();
  const before = await diagnostics(page);
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.loseOwner();
  });
  await expect(page.getByText(pendingOutcome, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check saved receipt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  const unavailable = await diagnostics(page);
  expect(unavailable.statusCalls).toBeGreaterThan(before.statusCalls);
  expect(unavailable.proposalCalls).toBe(before.proposalCalls);
  expect(unavailable.reviewCalls).toEqual(before.reviewCalls);
  expect(unavailable.dispatchCount).toBe(1);
  await capture(page, "pending-owner-unavailable-cleared");

  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.changeOwner();
  });
  await expect(
    page.getByRole("heading", { name: "Alarms", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Clock proposals", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(pendingOutcome, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check saved receipt", exact: true }),
  ).toHaveCount(0);
  const changed = await diagnostics(page);
  expect(changed.reviewCalls).toEqual(before.reviewCalls);
  expect(changed.dispatchCount).toBe(1);
  expect(effects).toEqual([]);
  await capture(page, "new-owner-after-unavailable");
});

test("failed saved receipt reconciliation remains reachable through owned refresh without redispatch", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "receipt-reconcile-failure");
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  const pendingOutcome =
    "Clock result: unknown; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.";
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  const receipt = page.getByRole("button", {
    name: "Check saved receipt",
    exact: true,
  });
  await expect(receipt).toBeEnabled();
  await receipt.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Controlled saved receipt reconciliation failed",
  );
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  await expect(receipt).toBeEnabled();
  const failed = await diagnostics(page);
  expect(failed.reviewCalls.map((call) => call.state)).toEqual([
    "pending",
    "reconciliation_required",
  ]);
  expect(failed.dispatchCount).toBe(1);
  await capture(page, "saved-reconciliation-failed", receipt);

  await page
    .getByRole("button", { name: "Refresh Clock requests", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(pendingOutcome);
  await expect(receipt).toBeEnabled();
  const refreshed = await diagnostics(page);
  expect(refreshed.proposalCalls).toBeGreaterThan(failed.proposalCalls);
  expect(refreshed.reviewCalls).toEqual(failed.reviewCalls);
  expect(refreshed.dispatchCount).toBe(1);
  await receipt.click();
  await expect(page.getByRole("status")).toHaveText(
    "Clock result: unknown. No installed or ringing alarm is confirmed.",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(receipt).toHaveCount(0);
  const actual = await diagnostics(page);
  expect(actual.reviewCalls.map((call) => call.state)).toEqual([
    "pending",
    "reconciliation_required",
    "reconciliation_required",
  ]);
  expect(actual.dispatchCount).toBe(1);
  expect(effects).toEqual([]);
  await capture(page, "saved-reconciliation-recovered");
});

test("settled Clock outcome survives explicit refresh retry but is retired with its owner", async ({
  page,
}) => {
  const effects = await openControlledClock(page, "opened-refresh-failure");
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toBeEnabled();
  const before = await diagnostics(page);
  await page
    .getByRole("button", { name: "Review on this phone", exact: true })
    .click();
  const savedOutcome =
    "Android Clock opened. Check the installed alarm there; ringing is not confirmed.";
  await expect(page.getByRole("status")).toHaveText(savedOutcome);
  const settled = await diagnostics(page);
  expect(settled.statusCalls).toBe(before.statusCalls);
  expect(settled.proposalCalls).toBe(before.proposalCalls);
  await page
    .getByRole("button", { name: "Refresh Clock requests", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.recoverForeground(false);
  });
  await page
    .getByRole("button", { name: "Refresh Clock requests", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(savedOutcome);
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  expect((await diagnostics(page)).dispatchCount).toBe(1);
  expect((await diagnostics(page)).reviewCalls).toHaveLength(1);
  await capture(page, "opened-explicit-refresh-retry");

  await page.evaluate(() => {
    (
      window as typeof window & { __clockHostUiBoundary: ControlledBoundary }
    ).__clockHostUiBoundary.changeOwner();
  });
  await expect(page.getByText(savedOutcome, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check saved receipt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review on this phone", exact: true }),
  ).toHaveCount(0);
  expect((await diagnostics(page)).dispatchCount).toBe(1);
  expect((await diagnostics(page)).reviewCalls).toHaveLength(1);
  expect(effects).toEqual([]);
  await capture(page, "opened-owner-retired");
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 393, height: 852 },
]) {
  test(`expired pending Clock proposal cannot begin a native review ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
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
    await capture(page, `expired-pending-${viewport.name}`);
  });
}

test("Clock host read failure remains a visible error", async ({ page }) => {
  const effects = await openControlledClock(page, "read-failure");
  await expect(page.getByRole("alert")).toHaveText(
    "Clock requests could not be refreshed. Controlled native boundary read failed",
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
  await page.evaluate(
    async (url) => {
      const { navigateBrowserPath } = await import(url);
      navigateBrowserPath("/automations");
    },
    `/@fs${path.join(repoRoot, "packages/ui/src/app-navigate-view.ts")}`,
  );
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
    page.getByRole("heading", { name: "Alarms", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Clock proposals", exact: true }),
  ).toHaveCount(0);
  expect((await diagnostics(page)).dispatchCount).toBe(0);
  expect(effects).toEqual([]);
  await capture(page, "owner-change-review-cancelled");
});

interface OwnedBoundary {
  calls(): { operation: ClockAlarmOperation; revision: number }[];
  failInventory(): void;
  recoverInventory(): void;
  replaceOwner(): void;
  deferRead(): void;
  resolveRead(): void;
}
async function openOwnedClock(page: Page, permissions = true) {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/clock");
  await expect(
    page.getByRole("heading", { name: "Alarms", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    async ({ url, permissions }) => {
      const module = await import(url);
      const listeners = new Set<() => void>();
      let owner = "a".repeat(64);
      let revision = 3;
      const grants = {
        exact: permissions,
        notifications: permissions,
        fullScreen: permissions,
      };
      let fail = false;
      let deferred = false;
      let resolveDeferred: ((value: ClockAlarmStatus) => void) | null = null;
      const calls: { operation: ClockAlarmOperation; revision: number }[] = [];
      const nextOccurrence = (
        hour: number,
        minute: number,
        days: readonly number[],
      ) => {
        const next = new Date();
        next.setHours(hour, minute, 0, 0);
        for (let offset = 0; offset <= 7; offset++) {
          if (
            next.getTime() > Date.now() &&
            (days.length === 0 || days.includes(next.getDay() + 1))
          )
            return next.getTime();
          next.setDate(next.getDate() + 1);
        }
        throw new Error("Controlled recurrence fixture has no next date");
      };
      let alarms: ClockAlarmRecord[] = [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          hour: 9,
          minute: 0,
          label: "Morning routine",
          timeZone: "America/Los_Angeles",
          days: [2, 3, 4, 5, 6],
          enabled: true,
          nextAt: nextOccurrence(9, 0, [2, 3, 4, 5, 6]),
          scheduleState: "scheduled",
          generation: 1,
          lastOutcome: "",
        },
      ];
      const snapshot = (): ClockAlarmStatus => ({
        available: true,
        reason: null,
        owner,
        alarmsRevision: revision,
        alarmsObservedAt: Date.now(),
        timeZone: "America/Los_Angeles",
        alarms: structuredClone(alarms),
        exactAlarmsAllowed: grants.exact,
        notificationsAllowed: grants.notifications,
        fullScreenAllowed: grants.fullScreen,
        alarmSoundMuted: false,
        defaultToneAvailable: true,
      });
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const host: ClockHost = {
        // An unavailable agent never hides the independent native alarm inventory.
        status: async () => {
          throw new Error("Controlled agent offline");
        },
        proposals: async () => {
          throw new Error("Controlled agent offline");
        },
        review: async () => {
          throw new Error("No proposal in owned alarm fixture");
        },
        retire: async () => {},
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async alarmStatus() {
          if (fail) throw new Error("Controlled native inventory read failed");
          const observed = snapshot();
          if (deferred) {
            deferred = false;
            return new Promise((resolve) => {
              resolveDeferred = resolve;
            }).then(() => observed);
          }
          return observed;
        },
        async manageAlarm(operation, alarmsRevision) {
          calls.push({
            operation: structuredClone(operation),
            revision: alarmsRevision,
          });
          if (alarmsRevision !== revision)
            throw new Error("Stale controlled alarm revision");
          revision++;
          const id =
            "alarmId" in operation
              ? operation.alarmId
              : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
          const selected = alarms.find((alarm) => alarm.id === id);
          let nextAt =
            operation.action === "set" || operation.action === "update"
              ? nextOccurrence(operation.hour, operation.minute, operation.days)
              : selected
                ? nextOccurrence(selected.hour, selected.minute, selected.days)
                : null;
          if (operation.action === "set" || operation.action === "update") {
            const enabled =
              operation.action === "set" || selected?.enabled === true;
            if (!enabled) nextAt = null;
            const record: ClockAlarmRecord = {
              hour: operation.hour,
              minute: operation.minute,
              label: operation.label,
              timeZone: operation.timeZone,
              days: operation.days,
              id,
              enabled,
              nextAt,
              scheduleState: enabled ? "scheduled" : "disabled",
              generation: 2,
              lastOutcome: "",
            };
            alarms =
              operation.action === "set"
                ? [...alarms, record]
                : alarms.map((alarm) => (alarm.id === id ? record : alarm));
            return {
              result: {
                kind: "clock-alarm",
                action: operation.action,
                status: operation.action === "set" ? "scheduled" : "updated",
                alarmId: id,
                nextAt,
              },
              alarmsRevision: revision,
            };
          }
          if (operation.action === "enable") {
            alarms = alarms.map((alarm) =>
              alarm.id === id
                ? {
                    ...alarm,
                    enabled: operation.enabled,
                    nextAt: operation.enabled ? nextAt : null,
                    scheduleState: operation.enabled ? "scheduled" : "disabled",
                  }
                : alarm,
            );
            return {
              result: {
                kind: "clock-alarm",
                action: "enable",
                status: operation.enabled ? "enabled" : "disabled",
                alarmId: id,
                nextAt: operation.enabled ? nextAt : null,
              },
              alarmsRevision: revision,
            };
          }
          if (operation.action === "delete") {
            alarms = alarms.filter((alarm) => alarm.id !== id);
            return {
              result: {
                kind: "clock-alarm",
                action: "delete",
                status: "deleted",
                alarmId: id,
              },
              alarmsRevision: revision,
            };
          }
          throw new Error("Unexpected controlled alarm operation");
        },
        async requestAlarmPermission(permission) {
          grants[permission] = true;
        },
      };
      module.configureClockHost(host);
      (
        window as typeof window & { __ownedClockBoundary: OwnedBoundary }
      ).__ownedClockBoundary = {
        calls: () => structuredClone(calls),
        failInventory() {
          fail = true;
          notify();
        },
        recoverInventory() {
          fail = false;
          notify();
        },
        deferRead() {
          deferred = true;
          notify();
        },
        resolveRead() {
          resolveDeferred?.(snapshot());
        },
        replaceOwner() {
          owner = "b".repeat(64);
          alarms = [
            {
              ...alarms[0],
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              label: "New owner alarm",
            },
          ];
          notify();
        },
      };
    },
    { url: bridgeUrl, permissions },
  );
  await expect(
    page.getByRole("listitem", { name: "Morning routine", exact: true }),
  ).toBeVisible();
}
async function ownedCalls(page: Page) {
  return page.evaluate(() =>
    (
      window as typeof window & { __ownedClockBoundary: OwnedBoundary }
    ).__ownedClockBoundary.calls(),
  );
}
for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 393, height: 852 },
]) {
  test(`owned alarms local controls and overview ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openOwnedClock(page);
    await expect(page.getByText("Time on this device")).toHaveCount(0);
    await expect(page.getByText("Manage reminders")).toHaveCount(0);
    await expect(page.locator("#clock-alarm-time")).toHaveCount(0);
    await page.getByRole("button", { name: "Add alarm", exact: true }).click();
    await page.locator("#clock-alarm-label").fill("朝の目覚まし — Work days");
    await page.getByLabel("Repeat", { exact: true }).selectOption("daily");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const row = page.getByRole("listitem", {
      name: "朝の目覚まし — Work days",
      exact: true,
    });
    await expect(row).toBeVisible();
    expect((await ownedCalls(page))[0]).toMatchObject({
      revision: 3,
      operation: {
        type: "clock_alarm",
        action: "set",
        hour: 9,
        minute: 0,
        days: [1, 2, 3, 4, 5, 6, 7],
      },
    });
    await row
      .getByRole("button", {
        name: "Edit 朝の目覚まし — Work days",
        exact: true,
      })
      .click();
    await page.getByLabel("Alarm time", { exact: true }).fill("09:30");
    await page.getByLabel("Repeat", { exact: true }).selectOption("custom");
    for (const day of ["Sunday", "Tuesday", "Thursday", "Saturday"])
      await page.getByRole("button", { name: day, exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.getByText("09:30", { exact: true })).toBeVisible();
    expect((await ownedCalls(page))[1]).toMatchObject({
      revision: 4,
      operation: {
        action: "update",
        alarmId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        days: [2, 4, 6],
      },
    });
    const directory = testOutputPath("owned-native-alarms", "minimal-renderer");
    await mkdir(directory, { recursive: true });
    await page
      .getByRole("heading", { name: "Alarms", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${directory}/${viewport.name}-overview.png`,
      fullPage: true,
    });
    await row
      .getByRole("button", {
        name: "Edit 朝の目覚まし — Work days",
        exact: true,
      })
      .click();
    await page.screenshot({
      path: `${directory}/${viewport.name}-editor.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await row
      .getByRole("button", {
        name: "Edit 朝の目覚まし — Work days",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Delete alarm", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect(
      (await ownedCalls(page)).map((call) => call.operation.action),
    ).toEqual(["set", "update", "enable", "delete"]);
  });
}
test("owned alarms permissions, failed inventory and old owner reads are explicit", async ({
  page,
}) => {
  await openOwnedClock(page, false);
  const row = page.getByRole("listitem", {
    name: "Morning routine",
    exact: true,
  });
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await row
    .getByRole("button", { name: "Edit Morning routine", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Alarm time", { exact: true }).fill("09:05");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByText("09:05", { exact: true })).toBeVisible();
  await expect(row.getByRole("switch")).toBeDisabled();
  await page.getByRole("button", { name: "Allow alarms", exact: true }).click();
  await page
    .getByRole("button", { name: "Allow notifications", exact: true })
    .click();
  await expect(row.getByRole("switch")).toBeEnabled();
  await page.evaluate(() =>
    (
      window as typeof window & { __ownedClockBoundary: OwnedBoundary }
    ).__ownedClockBoundary.failInventory(),
  );
  await expect(
    page.getByText("Controlled native inventory read failed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem", { name: "Morning routine", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as typeof window & { __ownedClockBoundary: OwnedBoundary }
    ).__ownedClockBoundary.recoverInventory(),
  );
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Edit Morning routine", exact: true })
    .click();
  await page.evaluate(() => {
    const b = (
      window as typeof window & { __ownedClockBoundary: OwnedBoundary }
    ).__ownedClockBoundary;
    b.deferRead();
    b.replaceOwner();
  });
  await expect(
    page.getByRole("listitem", { name: "New owner alarm", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as typeof window & { __ownedClockBoundary: OwnedBoundary }
    ).__ownedClockBoundary.resolveRead(),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("listitem", { name: "Morning routine", exact: true }),
  ).toHaveCount(0);
});

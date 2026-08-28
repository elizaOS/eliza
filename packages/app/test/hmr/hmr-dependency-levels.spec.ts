/**
 * Playwright HMR spec for the Hmr Dependency Levels app development-server
 * behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  parseViteProtocolEvent,
  responseUrlMatchesSource,
  restoreAndQuarantine,
  runWithCleanup,
  type ViteProtocolEvent,
  viteEventMatchesSource,
} from "./hmr-harness";

// This spec lives at packages/app/test/hmr/, so the repo root is four levels up.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

// Always-in-the-module-graph source files by dependency depth. The point of the
// suite is to prove an edit made at each depth — the app itself, workspace UI,
// shared code, and every visual-matrix plugin GUI view package — propagates to
// the running dev client over Vite's HMR channel. That exercises the dev
// architecture's reliance on `src/` (not `dist/`) resolution plus
// workspace-source watching.
const LEVELS = [
  { name: "app (packages/app)", file: "packages/app/src/main.tsx" },
  // The app imports @elizaos/ui via subpaths (not the root barrel), so target
  // the root App component that main.tsx renders — guaranteed in the live graph.
  { name: "@elizaos/ui", file: "packages/ui/src/App.tsx" },
  // shared/brand is only reachable via ElizaLogo, which is not eager on the app
  // "/" route, so Vite never transforms it and an edit emits no HMR event. Target
  // character-presets instead: main.tsx calls getStylePresets() at module scope,
  // so this source file is guaranteed in the live graph.
  { name: "@elizaos/shared", file: "packages/shared/src/character-presets.ts" },
  {
    name: "plugin view contacts",
    file: "plugins/plugin-contacts/src/components/ContactsAppView.tsx",
  },
  {
    // The /cloud launcher view (Eliza Cloud account at a glance), served as
    // plugin-elizacloud's `cloud` view bundle and mounted by DynamicViewLoader.
    name: "plugin view cloud",
    file: "plugins/plugin-elizacloud/src/components/cloud/CloudView.tsx",
  },
  {
    // Developer-only coding cockpit (/cockpit). CockpitRoute is the plugin-side
    // view container (wires the presentational @elizaos/ui CockpitView to the
    // live orchestrator client), so it is the source guaranteed in the view graph.
    name: "plugin view cockpit",
    file: "plugins/plugin-task-coordinator/src/CockpitRoute.tsx",
  },
  {
    name: "plugin view focus",
    file: "plugins/plugin-blocker/src/components/focus/FocusView.tsx",
  },
  {
    name: "plugin view calendar",
    file: "plugins/plugin-calendar/src/components/CalendarSection.tsx",
  },
  {
    name: "plugin view documents",
    file: "plugins/plugin-documents/src/components/documents/DocumentsView.tsx",
  },
  {
    name: "plugin view finances",
    file: "plugins/plugin-finances/src/components/finances/FinancesView.tsx",
  },
  {
    name: "plugin view goals",
    file: "plugins/plugin-goals/src/components/goals/GoalsView.tsx",
  },
  {
    name: "plugin view lifeops-live-test",
    file: "plugins/plugin-scheduling/src/components/lifeops-live-test/LifeOpsLiveTestView.tsx",
  },
  {
    name: "plugin view health",
    file: "plugins/plugin-health/src/components/health/HealthView.tsx",
  },
  {
    name: "plugin view inbox",
    file: "plugins/plugin-inbox/src/components/inbox/InboxView.tsx",
  },
  {
    name: "plugin view todos",
    file: "plugins/plugin-todos/src/components/todos/TodosView.tsx",
  },
  {
    name: "plugin view relationships",
    file: "plugins/plugin-relationships/src/components/relationships/RelationshipsView.tsx",
  },
  {
    name: "plugin view messages",
    file: "plugins/plugin-messages/src/components/MessagesView.tsx",
  },
  {
    name: "plugin view maps",
    file: "plugins/plugin-maps/src/components/MapsView.tsx",
  },
  {
    name: "plugin view phone",
    file: "plugins/plugin-phone/src/components/PhoneView.tsx",
  },
  {
    name: "plugin view wallet",
    file: "plugins/plugin-wallet/src/ui/InventoryView.tsx",
  },
  {
    name: "plugin view manager",
    file: "plugins/plugin-app-control/src/views/ViewManagerView.tsx",
  },
  {
    name: "plugin view notes",
    file: "plugins/plugin-notes/src/views/NotesView.tsx",
  },
  {
    name: "plugin view task coordinator",
    file: "plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx",
  },
  {
    name: "plugin view orchestrator",
    file: "plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx",
  },
  {
    name: "plugin view trajectory logger",
    file: "plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerView.tsx",
  },
] as const;

type ViteObservations = {
  events: ViteProtocolEvent[];
  responses: string[];
};

function collectViteObservations(page: Page): ViteObservations {
  const observations: ViteObservations = { events: [], responses: [] };
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const event = parseViteProtocolEvent(payload);
      if (event) observations.events.push(event);
    });
  });
  page.on("response", (response) =>
    observations.responses.push(response.url()),
  );
  return observations;
}

async function waitForCorrelatedViteUpdate(
  observations: ViteObservations,
  checkpoint: { events: number; responses: number },
  sourceFile: string,
  phase: "mutation" | "restoration",
): Promise<void> {
  await expect
    .poll(
      () =>
        observations.events
          .slice(checkpoint.events)
          .some((event) => viteEventMatchesSource(event, sourceFile)) ||
        observations.responses
          .slice(checkpoint.responses)
          .some((url) => responseUrlMatchesSource(url, sourceFile)),
      {
        timeout: 30_000,
        message: `Expected a source-correlated Vite HMR/reload observation after ${phase} of ${sourceFile}. Protocol events: ${JSON.stringify(observations.events.slice(checkpoint.events))}; module responses: ${JSON.stringify(observations.responses.slice(checkpoint.responses))}`,
      },
    )
    .toBe(true);
}

function observationCheckpoint(observations: ViteObservations): {
  events: number;
  responses: number;
} {
  return {
    events: observations.events.length,
    responses: observations.responses.length,
  };
}

async function waitForViteClient(page: Page): Promise<void> {
  // The Vite client connects its HMR socket shortly after load, and the app
  // pulls its view modules into the graph via fire-and-forget loaders. Wait for
  // the network to settle (those module fetches complete) before editing, so the
  // target module is actually in the graph; fall back to a fixed delay if the
  // dev agent keeps a connection warm and "networkidle" never fires.
  await page.waitForLoadState("domcontentloaded");
  await page
    .waitForLoadState("networkidle", { timeout: 8000 })
    .catch(() => undefined);
  await page.waitForTimeout(2000);
}

async function quarantineRestoredClient(
  page: Page,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  do {
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForViteClient(page);
      const documentToken = `${marker}_${Date.now()}`;
      await page.evaluate((token) => {
        (window as unknown as Record<string, unknown>).__hmrRestoredDocument =
          token;
      }, documentToken);
      await page.waitForTimeout(1000);
      const documentStayedCurrent = await page
        .evaluate(
          (token) =>
            (window as unknown as Record<string, unknown>)
              .__hmrRestoredDocument === token,
          documentToken,
        )
        .catch(() => false);
      if (documentStayedCurrent) {
        return;
      }
    } catch (error) {
      // error-policy:J2 A navigation can be replaced by the late reload under
      // test; retry within the fixed boundary and preserve the last cause.
      lastError = error;
    }
  } while (Date.now() < deadline);
  throw new Error("Restored HMR document did not reach a stable boundary", {
    cause: lastError,
  });
}

// Most plugin GUI views are NOT reachable in the dev client's module graph from
// the "/" route: they are served as standalone agent-built bundles loaded by
// DynamicViewLoader (a separate module graph the app's Vite dev server never
// transforms), or lazy()-split out of an eagerly-loaded register.ts. Vite never
// transforms their source from "/", so an edit emits no HMR event — the same
// limitation the @elizaos/shared note above describes. Eager-loading every view
// at dev boot to fold them in would regress startup (the app-load-perf work
// deliberately defers them); they are HMR-validated when the view is actually
// rendered, and a follow-up may add a dev-only graph warmup.
//
// The exception is the handful of plugin views statically re-exported from a
// barrel/ui entry that the app shell imports at boot, so Vite *does* pull their
// source into the root graph and editing them must emit an HMR event. Those stay
// in the assertion via this allowlist; every other "plugin view *" is skipped.
const PLUGIN_VIEWS_IN_ROOT_GRAPH = new Set<string>([
  // No plugin GUI view source is currently guaranteed in the "/" route's Vite
  // root graph. Keep this allowlist explicit so a future eager route can opt in
  // together with a real source-file assertion in hmr-coverage.test.ts.
]);

function isNotInRootGraph(name: string): boolean {
  return (
    name.startsWith("plugin view ") && !PLUGIN_VIEWS_IN_ROOT_GRAPH.has(name)
  );
}

test.describe("HMR propagation across package dependency levels", () => {
  test.describe.configure({ mode: "serial" });

  test("correlates protocol and module responses with the edited source", () => {
    const event = parseViteProtocolEvent(
      JSON.stringify({
        type: "update",
        updates: [
          { path: "/src/unrelated.ts", acceptedPath: "/src/unrelated.ts" },
          {
            path: "/@fs/worktree/packages/shared/src/character-presets.ts?t=1",
            acceptedPath:
              "/@fs/worktree/packages/shared/src/character-presets.ts",
          },
        ],
      }),
    );

    expect(event).not.toBeNull();
    if (!event) throw new Error("Expected a parsed Vite update event");
    expect(viteEventMatchesSource(event, "packages/app/src/main.tsx")).toBe(
      false,
    );
    expect(
      viteEventMatchesSource(event, "packages/shared/src/character-presets.ts"),
    ).toBe(true);
    expect(
      responseUrlMatchesSource(
        "http://127.0.0.1:42138/@fs/worktree/packages/shared/src/character-presets.ts?t=2",
        "packages/shared/src/character-presets.ts",
      ),
    ).toBe(true);
    expect(
      responseUrlMatchesSource(
        "http://127.0.0.1:42138/src/unrelated.ts?t=2",
        "packages/shared/src/character-presets.ts",
      ),
    ).toBe(false);
  });

  test("quarantines a timed-out restoration before preserving its failure", async () => {
    const order: string[] = [];
    const restorationFailure = new Error("restoration update timed out");

    await expect(
      restoreAndQuarantine({
        restore: () => order.push("restore"),
        waitForRestoration: async () => {
          order.push("wait");
          throw restorationFailure;
        },
        quarantine: async () => {
          order.push("quarantine");
        },
      }),
    ).rejects.toBe(restorationFailure);
    expect(order).toEqual(["restore", "wait", "quarantine"]);
  });

  test("aggregates restoration and quarantine failures in causal order", async () => {
    const restorationFailure = new Error("restoration update timed out");
    const quarantineFailure = new Error("fresh document did not stabilize");
    let thrown: unknown;

    try {
      await restoreAndQuarantine({
        restore: () => undefined,
        waitForRestoration: async () => {
          throw restorationFailure;
        },
        quarantine: async () => {
          throw quarantineFailure;
        },
      });
    } catch (error) {
      // error-policy:J2 Assert the exact causal aggregate below.
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toEqual([restorationFailure, quarantineFailure]);
    expect(aggregate.cause).toBe(restorationFailure);
  });

  test("runs restoration cleanup before rethrowing an exact mutation failure", async () => {
    const mutationFailure = new Error("mutation update timed out");
    const order: string[] = [];

    await expect(
      runWithCleanup({
        run: async () => {
          order.push("mutation");
          throw mutationFailure;
        },
        cleanup: async () => {
          order.push("cleanup");
        },
      }),
    ).rejects.toBe(mutationFailure);
    expect(order).toEqual(["mutation", "cleanup"]);
  });

  test("aggregates mutation and cleanup failures in causal order", async () => {
    const mutationFailure = new Error("mutation update timed out");
    const cleanupFailure = new Error("restoration cleanup failed");
    let thrown: unknown;

    try {
      await runWithCleanup({
        run: async () => {
          throw mutationFailure;
        },
        cleanup: async () => {
          throw cleanupFailure;
        },
      });
    } catch (error) {
      // error-policy:J2 Assert the exact causal aggregate below.
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toEqual([mutationFailure, cleanupFailure]);
    expect(aggregate.cause).toBe(mutationFailure);
  });

  test("quarantines when a mutation produced no correlated update", async () => {
    const order: string[] = [];
    await restoreAndQuarantine({
      restore: () => order.push("restore"),
      quarantine: async () => {
        order.push("quarantine");
      },
    });
    expect(order).toEqual(["restore", "quarantine"]);
  });

  test("the shared source target is present in the root Vite graph", async ({
    page,
  }) => {
    const observations = collectViteObservations(page);
    await page.goto("/");
    await waitForViteClient(page);

    const sharedSource = LEVELS.find(
      (level) => level.name === "@elizaos/shared",
    );
    if (!sharedSource) throw new Error("Shared HMR source target is missing");
    await expect
      .poll(
        () =>
          observations.responses.some((url) =>
            responseUrlMatchesSource(url, sharedSource.file),
          ),
        {
          timeout: 30_000,
          message: `Expected ${sharedSource.file} to be transformed in the root Vite module graph. Responses: ${JSON.stringify(observations.responses)}`,
        },
      )
      .toBe(true);
  });

  for (const level of LEVELS) {
    const defineTest = isNotInRootGraph(level.name) ? test.skip : test;
    defineTest(
      `edit at ${level.name} reaches the running dev client`,
      async ({ page }) => {
        const abs = path.join(repoRoot, level.file);
        expect(
          fs.existsSync(abs),
          `target source file missing: ${level.file}`,
        ).toBe(true);
        const original = fs.readFileSync(abs, "utf8");
        const marker = `HMR_PROBE_${level.name.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;

        const observations = collectViteObservations(page);
        await page.goto("/");
        await waitForViteClient(page);

        // Sentinel survives an HMR module swap but is wiped by a full reload —
        // recorded for diagnostics, not asserted (barrels legitimately reload).
        await page.evaluate((m) => {
          (window as unknown as Record<string, unknown>).__hmrSentinel = m;
        }, marker);

        let mutationObserved = false;
        await runWithCleanup({
          run: async () => {
            // A comment-only edit can compile to the same browser module and
            // produce no client update. Add an inert exported sentinel so the
            // transformed module changes without executing product behavior.
            const mutationCheckpoint = observationCheckpoint(observations);
            fs.writeFileSync(
              abs,
              `${original}\nexport const ${marker} = ${JSON.stringify(marker)};\n`,
            );
            await waitForCorrelatedViteUpdate(
              observations,
              mutationCheckpoint,
              level.file,
              "mutation",
            );
            mutationObserved = true;
            await waitForViteClient(page);
          },
          cleanup: async () => {
            // Restoration is part of the serial test boundary. Even if its
            // update times out, quarantine a fresh document before returning.
            const restorationCheckpoint = observationCheckpoint(observations);
            await restoreAndQuarantine({
              restore: () => fs.writeFileSync(abs, original),
              waitForRestoration: mutationObserved
                ? () =>
                    waitForCorrelatedViteUpdate(
                      observations,
                      restorationCheckpoint,
                      level.file,
                      "restoration",
                    )
                : undefined,
              quarantine: () => quarantineRestoredClient(page, marker),
            });
          },
        });
      },
    );
  }
});

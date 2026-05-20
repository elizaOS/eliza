import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViewDeclaration } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.js";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  resolveViewInteractResult,
  type ViewsRouteContext,
} from "../api/views-routes.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const VIEW_MANIFESTS = [
  "plugins/plugin-companion/src/plugin.ts",
  "plugins/plugin-contacts/src/plugin.ts",
  "plugins/plugin-hyperliquid-app/src/plugin.ts",
  "plugins/plugin-lifeops/src/plugin.ts",
  "plugins/plugin-messages/src/plugin.ts",
  "plugins/app-model-tester/src/plugin.ts",
  "plugins/plugin-phone/src/plugin.ts",
  "plugins/plugin-polymarket-app/src/plugin.ts",
  "plugins/plugin-shopify-ui/src/plugin.ts",
  "plugins/plugin-steward-app/src/plugin.ts",
  "plugins/plugin-vincent/src/plugin.ts",
  "plugins/plugin-wallet-ui/src/plugin.ts",
  "plugins/plugin-2004scape/src/index.ts",
  "plugins/plugin-babylon/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-clawville/src/index.ts",
  "plugins/plugin-defense-of-the-agents/src/index.ts",
  "plugins/plugin-hyperscape/src/index.ts",
  "plugins/plugin-scape/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/index.ts",
  "plugins/plugin-training/src/setup-routes.ts",
  "plugins/plugin-hearwear/src/index.ts",
] as const;

const TUI_PARITY_CAPABILITIES: Record<string, readonly string[]> = {
  "plugins/plugin-companion/src/components/companion/CompanionView.tsx": [
    "terminal-companion-state",
    "terminal-companion-emotes",
    "terminal-companion-play-emote",
    "terminal-companion-stop-emote",
  ],
  "plugins/plugin-contacts/src/components/ContactsAppView.tsx": [
    "terminal-list-contacts",
    "terminal-create-contact",
    "terminal-import-vcard",
  ],
  "plugins/plugin-hyperliquid-app/src/HyperliquidAppView.tsx": [
    "terminal-hyperliquid-state",
    "terminal-hyperliquid-market",
    "terminal-hyperliquid-execution-check",
  ],
  "plugins/plugin-lifeops/src/components/LifeOpsPageView.tsx": [
    "terminal-lifeops-state",
    "terminal-lifeops-enable",
    "terminal-lifeops-complete",
    "terminal-lifeops-skip",
    "terminal-lifeops-snooze",
  ],
  "plugins/plugin-messages/src/components/MessagesAppView.tsx": [
    "terminal-list-threads",
    "terminal-send-sms",
    "terminal-request-sms-role",
  ],
  "plugins/app-model-tester/src/ModelTesterAppView.tsx": [
    "get-status",
    "run-text-small",
    "run-transcription",
    "run-vision",
    "run-vad",
  ],
  "plugins/plugin-phone/src/components/PhoneAppView.tsx": [
    "terminal-phone-state",
    "terminal-place-call",
    "terminal-open-dialer",
    "terminal-save-call-transcript",
  ],
  "plugins/plugin-polymarket-app/src/PolymarketAppView.tsx": [
    "terminal-polymarket-state",
    "terminal-polymarket-market",
    "terminal-polymarket-orderbook",
    "terminal-polymarket-positions",
    "terminal-polymarket-trading-check",
  ],
  "plugins/plugin-shopify-ui/src/ShopifyAppView.tsx": [
    "terminal-shopify-state",
    "terminal-shopify-products",
    "terminal-shopify-orders",
    "terminal-shopify-inventory",
    "terminal-shopify-customers",
    "terminal-shopify-create-product",
    "terminal-shopify-adjust-inventory",
  ],
  "plugins/plugin-steward-app/src/StewardView.tsx": [
    "terminal-steward-state",
    "terminal-steward-pending",
    "terminal-steward-history",
    "terminal-steward-approve",
    "terminal-steward-deny",
  ],
  "plugins/plugin-vincent/src/VincentAppView.tsx": [
    "terminal-vincent-state",
    "terminal-vincent-start-login",
    "terminal-vincent-disconnect",
    "terminal-vincent-update-strategy",
  ],
  "plugins/plugin-wallet-ui/src/InventoryView.tsx": [
    "terminal-wallet-state",
    "terminal-wallet-market-overview",
    "terminal-wallet-trading-profile",
  ],
  "plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.tsx": [
    "terminal-2004scape-state",
    "terminal-2004scape-command",
    "terminal-2004scape-pause",
    "terminal-2004scape-resume",
  ],
  "plugins/plugin-babylon/src/ui/BabylonOperatorSurface.tsx": [
    "get-state",
    "refresh-agent-status",
    "open-live-dashboard",
    "send-team-message",
  ],
  "plugins/plugin-app-control/src/views/ViewManagerView.tsx": [
    "terminal-list-views",
    "terminal-open-view",
  ],
  "plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.tsx": [
    "terminal-clawville-state",
    "terminal-clawville-command",
  ],
  "plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface.tsx":
    ["terminal-defense-state", "terminal-defense-command"],
  "plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.tsx": [
    "terminal-hyperscape-state",
    "terminal-hyperscape-command",
    "terminal-hyperscape-control",
  ],
  "plugins/plugin-scape/src/ui/ScapeOperatorSurface.tsx": [
    "terminal-scape-state",
    "terminal-scape-command",
    "terminal-scape-control",
  ],
  "plugins/plugin-screenshare/src/ui/ScreenshareOperatorSurface.tsx": [
    "terminal-screenshare-state",
    "terminal-screenshare-start",
    "terminal-screenshare-session",
    "terminal-screenshare-stop",
    "terminal-screenshare-input",
    "terminal-screenshare-viewer-url",
  ],
  "plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx": [
    "list-sessions",
    "list-task-threads",
    "open-thread",
    "stop-session",
    "refresh",
  ],
  "plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerView.tsx": [
    "list-trajectories",
    "open-latest",
    "filter-phase",
    "refresh",
  ],
  "plugins/plugin-training/src/ui/FineTuningView.tsx": [
    "terminal-training-state",
    "terminal-training-trajectory",
    "terminal-training-build-dataset",
    "terminal-training-start-job",
    "terminal-training-cancel-job",
    "terminal-training-import-model",
    "terminal-training-activate-model",
    "terminal-training-benchmark-model",
  ],
};

function readManifest(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function viewObjects(source: string): string[] {
  const viewsStart = source.indexOf("views:");
  if (viewsStart === -1) return [];
  const arrayStart = source.indexOf("[", viewsStart);
  if (arrayStart === -1) return [];

  let depth = 0;
  let arrayEnd = -1;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      arrayEnd = index;
      break;
    }
  }
  if (arrayEnd === -1) return [];

  const viewsSource = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let objectStart = -1;
  depth = 0;
  for (let index = 0; index < viewsSource.length; index += 1) {
    const char = viewsSource[index];
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(viewsSource.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  return objects.filter(
    (chunk) => chunk.includes("id:") && chunk.includes("componentExport:"),
  );
}

function stringField(source: string, field: string): string | null {
  const match = source.match(new RegExp(`${field}:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

function viewDeclarations(manifestPath: string): ViewDeclaration[] {
  return viewObjects(readManifest(manifestPath))
    .map((object): ViewDeclaration | null => {
      const id = stringField(object, "id");
      const label = stringField(object, "label");
      const path = stringField(object, "path");
      const viewType = stringField(object, "viewType");
      const bundlePath = stringField(object, "bundlePath");
      const componentExport = stringField(object, "componentExport");
      if (!id || !label || !bundlePath || !componentExport) return null;
      return {
        id,
        label,
        ...(path === null ? {} : { path }),
        ...(viewType === "tui" ? { viewType: "tui" as const } : {}),
        bundlePath,
        componentExport,
        visibleInManager: true,
      } satisfies ViewDeclaration;
    })
    .filter((view): view is ViewDeclaration => view !== null);
}

function makeCtx(
  method: string,
  pathname: string,
  broadcastWs?: (payload: object) => void,
  body?: unknown,
  json?: (res: http.ServerResponse, body: unknown) => void,
  error?: (res: http.ServerResponse, message: string, status?: number) => void,
): ViewsRouteContext {
  const url = new URL(`http://localhost${pathname}`);
  const req = new EventEmitter() as http.IncomingMessage;
  req.headers = {};
  if (body !== undefined) {
    const chunk = Buffer.from(JSON.stringify(body));
    process.nextTick(() => {
      req.emit("data", chunk);
      req.emit("end");
    });
  } else if (method === "POST") {
    process.nextTick(() => req.emit("end"));
  }
  return {
    req,
    res: {} as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    json: json ?? (() => {}),
    error: error ?? (() => {}),
    broadcastWs,
  };
}

describe("plugin TUI view coverage", () => {
  it("keeps a terminal parity capability surface for every bundled TUI", () => {
    const failures: string[] = [];

    for (const [sourcePath, capabilities] of Object.entries(
      TUI_PARITY_CAPABILITIES,
    )) {
      const source = readManifest(sourcePath);
      for (const capability of capabilities) {
        if (!source.includes(capability)) {
          failures.push(`${sourcePath}:${capability}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("registers a tui override for every bundled gui plugin view", () => {
    const missing: string[] = [];

    for (const manifestPath of VIEW_MANIFESTS) {
      const objects = viewObjects(readManifest(manifestPath));
      const guiIds = new Set<string>();
      const tuiIds = new Set<string>();

      for (const object of objects) {
        const id = stringField(object, "id");
        const viewType = stringField(object, "viewType") ?? "gui";
        const bundlePath = stringField(object, "bundlePath");
        if (!id || !bundlePath) continue;
        if (viewType === "tui") tuiIds.add(id);
        else guiIds.add(id);
      }

      for (const id of guiIds) {
        if (!tuiIds.has(id)) missing.push(`${manifestPath}:${id}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("can route-switch every bundled plugin view in gui and tui mode", async () => {
    const pluginNames: string[] = [];
    const views: Array<{
      manifestPath: string;
      id: string;
      viewType: "gui" | "tui";
      path?: string;
    }> = [];

    try {
      for (const manifestPath of VIEW_MANIFESTS) {
        const declarations = viewDeclarations(manifestPath);
        const pluginName = `test:${manifestPath}`;
        pluginNames.push(pluginName);
        await registerPluginViews(
          {
            name: pluginName,
            description: `Test view manifest ${manifestPath}`,
            actions: [],
            views: declarations,
          } satisfies Plugin,
          undefined,
        );
        for (const declaration of declarations) {
          views.push({
            manifestPath,
            id: declaration.id,
            viewType: declaration.viewType ?? "gui",
            path: declaration.path,
          });
        }
      }

      const failures: string[] = [];
      for (const view of views) {
        const broadcasts: object[] = [];
        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/${encodeURIComponent(view.id)}/navigate?viewType=${view.viewType}`,
            (payload) => broadcasts.push(payload),
          ),
        );
        const event = broadcasts[0] as
          | {
              type?: string;
              viewId?: string;
              viewType?: string;
              viewPath?: string | null;
            }
          | undefined;
        if (
          event?.type !== "shell:navigate:view" ||
          event.viewId !== view.id ||
          event.viewType !== view.viewType ||
          event.viewPath !== view.path
        ) {
          failures.push(`${view.manifestPath}:${view.viewType}:${view.id}`);
        }
      }

      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });

  it("can dispatch standard interactions for every bundled plugin view in gui and tui mode", async () => {
    const pluginNames: string[] = [];
    const views: Array<{
      manifestPath: string;
      id: string;
      viewType: "gui" | "tui";
    }> = [];

    try {
      for (const manifestPath of VIEW_MANIFESTS) {
        const declarations = viewDeclarations(manifestPath);
        const pluginName = `test:${manifestPath}`;
        pluginNames.push(pluginName);
        await registerPluginViews(
          {
            name: pluginName,
            description: `Test view manifest ${manifestPath}`,
            actions: [],
            views: declarations,
          } satisfies Plugin,
          undefined,
        );
        for (const declaration of declarations) {
          views.push({
            manifestPath,
            id: declaration.id,
            viewType: declaration.viewType ?? "gui",
          });
        }
      }

      const failures: string[] = [];
      for (const view of views) {
        const broadcasts: object[] = [];
        let resultBody: unknown = null;
        let errorBody: { message: string; status?: number } | null = null;

        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/${encodeURIComponent(view.id)}/interact?viewType=${view.viewType}`,
            (payload) => {
              broadcasts.push(payload);
              const event = payload as {
                type?: string;
                requestId?: string;
                viewId?: string;
                viewType?: string;
              };
              if (
                event.type === "view:interact" &&
                typeof event.requestId === "string"
              ) {
                resolveViewInteractResult({
                  requestId: event.requestId,
                  success: true,
                  result: {
                    viewId: event.viewId,
                    viewType: event.viewType,
                    state: "ok",
                  },
                });
              }
            },
            { capability: "get-state", timeoutMs: 1_000 },
            (_res, body) => {
              resultBody = body;
            },
            (_res, message, status) => {
              errorBody = { message, status };
            },
          ),
        );

        const event = broadcasts[0] as
          | {
              type?: string;
              viewId?: string;
              viewType?: string;
              capability?: string;
            }
          | undefined;
        const result = resultBody as {
          success?: boolean;
          result?: { viewId?: string; viewType?: string; state?: string };
        } | null;
        if (
          errorBody ||
          event?.type !== "view:interact" ||
          event.viewId !== view.id ||
          event.viewType !== view.viewType ||
          event.capability !== "get-state" ||
          result?.success !== true ||
          result.result?.viewId !== view.id ||
          result.result?.viewType !== view.viewType
        ) {
          failures.push(`${view.manifestPath}:${view.viewType}:${view.id}`);
        }
      }

      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });
});

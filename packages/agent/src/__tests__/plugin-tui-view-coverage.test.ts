import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
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

type RoutedViewType = "gui" | "tui" | "xr";

function _isRoutedViewType(
  viewType: ViewDeclaration["viewType"],
): viewType is RoutedViewType {
  return viewType === "gui" || viewType === "tui" || viewType === "xr";
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const VIEW_MANIFESTS = [
  "plugins/plugin-contacts/src/plugin.ts",
  "plugins/plugin-hyperliquid/src/plugin.ts",
  "plugins/plugin-messages/src/plugin.ts",
  "plugins/app-model-tester/src/plugin.ts",
  "plugins/plugin-phone/src/plugin.ts",
  "plugins/plugin-polymarket/src/plugin.ts",
  "plugins/plugin-shopify/src/plugin.ts",
  "plugins/plugin-wallet-ui/src/plugin.ts",
  "plugins/plugin-feed/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/index.ts",
  "plugins/plugin-training/src/setup-routes.ts",
  "plugins/plugin-facewear/src/index.ts",
] as const;

const TUI_PARITY_CAPABILITIES: Record<string, readonly string[]> = {
  // Each collapsed plugin re-exports its `<Name>View` componentExport and the
  // `interact` capability handler from a `<name>-view-bundle.ts` entry file, so
  // that bundle entry owns the terminal parity capabilities (same pattern as
  // phone below).
  "plugins/plugin-contacts/src/components/contacts-view-bundle.ts": [
    "terminal-list-contacts",
    "terminal-create-contact",
    "terminal-import-vcard",
  ],
  "plugins/plugin-hyperliquid/src/hyperliquid-app-view-bundle.ts": [
    "terminal-hyperliquid-state",
    "terminal-hyperliquid-market",
    "terminal-hyperliquid-execution-check",
  ],
  "plugins/plugin-messages/src/components/messages-view-bundle.ts": [
    "terminal-list-threads",
    "terminal-send-sms",
    "terminal-request-sms-role",
  ],
  "plugins/app-model-tester/src/model-tester-view-bundle.ts": [
    "get-status",
    "run-text-small",
    "run-transcription",
    "run-vision",
    "run-vad",
  ],
  // The phone view collapsed to one declaration (componentExport "PhoneView",
  // modalities gui/xr/tui). The bundle entry re-exports both PhoneView and the
  // `interact` capability handler, so it owns the terminal parity capabilities.
  "plugins/plugin-phone/src/components/phone-view-bundle.ts": [
    "terminal-phone-state",
    "terminal-place-call",
    "terminal-open-dialer",
    "terminal-save-call-transcript",
  ],
  "plugins/plugin-polymarket/src/polymarket-view-bundle.ts": [
    "terminal-polymarket-state",
    "terminal-polymarket-market",
    "terminal-polymarket-orderbook",
    "terminal-polymarket-positions",
    "terminal-polymarket-trading-check",
  ],
  "plugins/plugin-shopify/src/shopify-view-bundle.ts": [
    "terminal-shopify-state",
    "terminal-shopify-products",
    "terminal-shopify-orders",
    "terminal-shopify-inventory",
    "terminal-shopify-customers",
    "terminal-shopify-create-product",
    "terminal-shopify-adjust-inventory",
  ],
  "plugins/plugin-wallet-ui/src/InventoryView.tsx": [
    "terminal-wallet-state",
    "terminal-wallet-market-overview",
    "terminal-wallet-trading-profile",
  ],
  "plugins/plugin-feed/src/ui/feed-view-bundle.ts": [
    "get-state",
    "refresh-agent-status",
    "open-live-dashboard",
    "send-team-message",
  ],
  // app-control wires its TUI view and the terminal capabilities together in
  // its plugin manifest (index.ts declares componentExport ViewManagerTuiView
  // plus the terminal-list-views / terminal-open-view capability ids); the
  // capability logic itself lives in views/viewManagerData.ts.
  "plugins/plugin-app-control/src/index.ts": [
    "terminal-list-views",
    "terminal-open-view",
  ],
  // Screenshare collapsed to ONE declaration (componentExport "ScreenshareView",
  // modalities gui/xr/tui). The bundle entry re-exports ScreenshareView plus the
  // `interact` capability handler (from screenshare-interact.ts), so this bundle
  // entry owns the terminal parity capabilities.
  "plugins/plugin-screenshare/src/ui/screenshare-view-bundle.ts": [
    "terminal-screenshare-state",
    "terminal-screenshare-start",
    "terminal-screenshare-session",
    "terminal-screenshare-stop",
    "terminal-screenshare-input",
    "terminal-screenshare-viewer-url",
  ],
  // The task-coordinator bundle re-exports BOTH collapsed view components
  // (`TaskCoordinatorView` and `OrchestratorView`) plus the shared `interact`
  // handler, so this one bundle entry owns the terminal parity capabilities for
  // both the task-coordinator and orchestrator declarations.
  "plugins/plugin-task-coordinator/src/task-coordinator-view-bundle.ts": [
    "list-sessions",
    "list-task-threads",
    "open-thread",
    "stop-session",
    "refresh",
    "orchestrator-status",
    "orchestrator-list-tasks",
    "orchestrator-open-task",
    "orchestrator-create-task",
    "orchestrator-pause-task",
    "orchestrator-resume-task",
    "orchestrator-pause-all",
    "orchestrator-resume-all",
    "orchestrator-delete-task",
    "orchestrator-fork-task",
    "orchestrator-update-task",
    "orchestrator-validate-task",
    "orchestrator-add-agent",
    "orchestrator-stop-agent",
    "orchestrator-send-message",
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
    "terminal-training-build-analysis-index",
    "terminal-training-build-readiness-report",
    "terminal-training-ingest-hf-dataset",
    "terminal-training-feed-generate",
    "terminal-training-run-scenarios",
    "terminal-training-run-eval-comparison",
    "terminal-training-run-collection",
    "terminal-training-write-benchmark-matrix",
    "terminal-training-run-benchmark-vs-cerebras",
    "terminal-training-stage-eliza1-bundle",
    "terminal-training-run-action-benchmark",
  ],
  // FacewearView dispatches capabilities through the generic TerminalPluginView,
  // so the capability ids live entirely in the plugin manifest's `capabilities`
  // arrays (index.ts) — that file also declares the FacewearView componentExport.
  "plugins/plugin-facewear/src/index.ts": [
    "connect-device",
    "manage-views",
    "device-diagnostics",
    "emulator",
    "connect-headset",
    "run-hardware-check",
    "guided-side-tap-audio-validation",
    "configure-wifi",
  ],
};

// GUI-only plugin views that intentionally ship without a terminal (TUI)
// override, keyed by `${manifestPath}:${id}`. The cockpit (#10419) is a
// mobile-first, touch-first coding deck (mode picker + live task room) declared
// with `modalities: ["gui"]`; it has no terminal rendering by design (the same
// orchestrator surface is available as a TUI via the `/orchestrator` view).
const GUI_ONLY_TUI_EXEMPTIONS = new Set<string>([
  "plugins/plugin-task-coordinator/src/index.ts:cockpit",
]);

function readManifest(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

// Capability ids may live in the component file, in a sibling `*.interact.ts`
// dispatch module (the Fast-Refresh split pattern), or in a same-directory
// helper that the interact module re-exports (e.g. orchestrator-capabilities.ts,
// split out so the interact file stays a thin delegator). Gather the component
// source plus any same-directory relative import targets it pulls in so the
// parity surface tracks the real id locations across those refactors.
function readCapabilitySource(path: string): string {
  const seen = new Set<string>();
  const collected: string[] = [];

  const visit = (absolutePath: string): void => {
    const normalized = absolutePath.replace(/\.[cm]?tsx?$/, "");
    if (seen.has(normalized) || !existsSync(absolutePath)) return;
    seen.add(normalized);
    const source = readFileSync(absolutePath, "utf8");
    collected.push(source);
    const dir = dirname(absolutePath);
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1].replace(/\.[cm]?tsx?$/, "");
      visit(resolve(dir, `${specifier}.ts`));
    }
  };

  const absolutePath = resolve(repoRoot, path);
  visit(absolutePath);
  visit(absolutePath.replace(/\.[cm]?tsx?$/, ".interact.ts"));
  return collected.join("\n");
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

/**
 * The surfaces a single view object draws: the `modalities: ["gui","xr","tui"]`
 * array literal when present (the collapsed one-source pattern), otherwise the
 * single `viewType` (default "gui"). One declaration drawing several surfaces
 * is equivalent to one duplicate declaration per surface for coverage purposes.
 */
function viewObjectModalities(object: string): RoutedViewType[] {
  const modalitiesMatch = object.match(/modalities:\s*\[([^\]]*)\]/);
  if (modalitiesMatch) {
    const mods = [...modalitiesMatch[1].matchAll(/"(gui|tui|xr)"/g)].map(
      (m) => m[1] as RoutedViewType,
    );
    if (mods.length > 0) return mods;
  }
  return [(stringField(object, "viewType") ?? "gui") as RoutedViewType];
}

function coveredViewType(
  viewType: ViewDeclaration["viewType"],
): RoutedViewType | undefined {
  const normalizedViewType = viewType ?? "gui";
  return normalizedViewType === "gui" ||
    normalizedViewType === "tui" ||
    normalizedViewType === "xr"
    ? normalizedViewType
    : undefined;
}

// viewDeclarations() only ever yields declarations whose componentExport is a
// present string (it filters out the rest), so narrow the core type — whose
// componentExport is optional for remote plugins — for these local consumers.
type CoveredView = ViewDeclaration & { componentExport: string };

function capabilitiesForDeclaration(
  declaration: CoveredView,
): readonly string[] {
  const owner = Object.entries(TUI_PARITY_CAPABILITIES).find(([sourcePath]) =>
    readManifest(sourcePath).includes(declaration.componentExport),
  );
  return owner?.[1] ?? [];
}

function viewDeclarations(manifestPath: string): CoveredView[] {
  return viewObjects(readManifest(manifestPath)).flatMap(
    (object): CoveredView[] => {
      const id = stringField(object, "id");
      const label = stringField(object, "label");
      const path = stringField(object, "path");
      const bundlePath = stringField(object, "bundlePath");
      const componentExport = stringField(object, "componentExport");
      if (!id || !label || !bundlePath || !componentExport) return [];
      // One declaration with `modalities` expands to one CoveredView per
      // surface — the same bundle + component routed in gui, tui, and xr.
      return viewObjectModalities(object).map((viewType) => ({
        id,
        label,
        ...(path === null ? {} : { path }),
        viewType,
        bundlePath,
        componentExport,
        visibleInManager: true,
      }));
    },
  );
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
  it("requires a terminal parity capability entry for every declared TUI component", () => {
    const paritySources = Object.keys(TUI_PARITY_CAPABILITIES).map(
      (sourcePath) => ({
        sourcePath,
        source: readManifest(sourcePath),
      }),
    );
    const missing: string[] = [];

    for (const manifestPath of VIEW_MANIFESTS) {
      for (const declaration of viewDeclarations(manifestPath)) {
        if (declaration.viewType !== "tui") continue;
        const owner = paritySources.find(({ source }) =>
          source.includes(declaration.componentExport),
        );
        if (!owner || TUI_PARITY_CAPABILITIES[owner.sourcePath].length === 0) {
          missing.push(
            `${manifestPath}:${declaration.id}:${declaration.componentExport}`,
          );
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps a terminal parity capability surface for every bundled TUI", () => {
    const failures: string[] = [];

    for (const [sourcePath, capabilities] of Object.entries(
      TUI_PARITY_CAPABILITIES,
    )) {
      const source = readCapabilitySource(sourcePath);
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
        const bundlePath = stringField(object, "bundlePath");
        if (!id || !bundlePath) continue;
        // A `modalities` declaration draws every listed surface from one
        // source, so it counts as both the gui view and its tui override.
        const modalities = viewObjectModalities(object);
        if (modalities.includes("tui")) tuiIds.add(id);
        if (modalities.includes("gui")) guiIds.add(id);
      }

      for (const id of guiIds) {
        if (tuiIds.has(id)) continue;
        const identity = `${manifestPath}:${id}`;
        if (GUI_ONLY_TUI_EXEMPTIONS.has(identity)) continue;
        missing.push(identity);
      }
    }

    expect(missing).toEqual([]);
  });

  it("can route-switch every bundled plugin view in gui, tui, and xr mode", async () => {
    const pluginNames: string[] = [];
    const views: Array<{
      manifestPath: string;
      id: string;
      viewType: RoutedViewType;
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
          const viewType = coveredViewType(declaration.viewType);
          if (!viewType) continue;
          views.push({
            manifestPath,
            id: declaration.id,
            viewType,
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

  it("can dispatch standard interactions for every bundled plugin view in gui, tui, and xr mode", async () => {
    const pluginNames: string[] = [];
    const views: Array<{
      manifestPath: string;
      id: string;
      viewType: RoutedViewType;
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
          const viewType = coveredViewType(declaration.viewType);
          if (!viewType) continue;
          views.push({
            manifestPath,
            id: declaration.id,
            viewType,
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

  it("can dispatch every bundled TUI capability through the view interaction route", async () => {
    const pluginNames: string[] = [];
    const capabilities: Array<{
      manifestPath: string;
      viewId: string;
      capability: string;
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
          if (declaration.viewType !== "tui") continue;
          for (const capability of capabilitiesForDeclaration(declaration)) {
            capabilities.push({
              manifestPath,
              viewId: declaration.id,
              capability,
            });
          }
        }
      }

      const failures: string[] = [];
      for (const target of capabilities) {
        const broadcasts: object[] = [];
        let resultBody: unknown = null;
        let errorBody: { message: string; status?: number } | null = null;

        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/${encodeURIComponent(target.viewId)}/interact?viewType=tui`,
            (payload) => {
              broadcasts.push(payload);
              const event = payload as {
                type?: string;
                requestId?: string;
                capability?: string;
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
                    capability: event.capability,
                    viewId: event.viewId,
                    viewType: event.viewType,
                  },
                });
              }
            },
            { capability: target.capability, timeoutMs: 1_000 },
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
              capability?: string;
              viewId?: string;
              viewType?: string;
            }
          | undefined;
        const result = resultBody as {
          success?: boolean;
          result?: {
            capability?: string;
            viewId?: string;
            viewType?: string;
          };
        } | null;

        if (
          errorBody ||
          event?.type !== "view:interact" ||
          event.viewId !== target.viewId ||
          event.viewType !== "tui" ||
          event.capability !== target.capability ||
          result?.success !== true ||
          result.result?.capability !== target.capability
        ) {
          failures.push(
            `${target.manifestPath}:tui:${target.viewId}:${target.capability}`,
          );
        }
      }

      expect(capabilities.length).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });
});

/**
 * Plugin view inventory ratchet + viewType infrastructure coverage (#15269).
 *
 * The shipped plugin-view inventory is GUI-only: every plugin manifest's
 * `views:` declarations are statically parsed from source and asserted to
 * declare no non-GUI surface. The viewType routing CONTRACT is preserved
 * infrastructure — the views-registry and `handleViewsRoutes` still accept
 * non-GUI requests — so this file also registers the real gui inventory through
 * the real views-registry, drives navigate / interact dispatch in gui mode, and
 * proves the designed degrade for non-GUI requests against a gui-only inventory:
 * `getView` falls back to the gui declaration (the broadcast + response carry
 * viewType "gui"), and unknown ids 404. No crash, no fabricated non-GUI
 * success.
 *
 * Harness realism: manifests are read off disk and the registry + route
 * dispatch are the real modules; a fake `IncomingMessage` and a
 * `resolveViewInteractResult` stub stand in for the async view-interact
 * round-trip that a live shell client would complete.
 */
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import type http from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
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

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const VIEW_MANIFESTS = discoverPluginViewManifestPaths();

function readManifest(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function discoverPluginViewManifestPaths(): string[] {
  const pluginRoot = resolve(repoRoot, "plugins");
  const discovered: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      const relativePath = relative(repoRoot, fullPath);
      if (entry.isDirectory()) {
        if (
          ["dist", "node_modules", "coverage"].includes(entry.name) ||
          relativePath.includes(`${sep}test${sep}`) ||
          relativePath.includes(`${sep}__tests__${sep}`)
        ) {
          continue;
        }
        visit(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (
        entry.name.endsWith(".d.ts") ||
        entry.name.includes(".test.") ||
        entry.name.includes(".spec.") ||
        entry.name === "vite.config.views.ts"
      ) {
        continue;
      }

      const source = readFileSync(fullPath, "utf8");
      if (!source.includes("views:") || !source.includes("componentExport:")) {
        continue;
      }
      if (viewObjects(source).length === 0) continue;
      discovered.push(relativePath.split(sep).join("/"));
    }
  };

  visit(pluginRoot);
  return [...new Set(discovered)].sort();
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
  const match = source.match(new RegExp(`${field}:\\s*["']([^"']+)["']`));
  return match?.[1] ?? null;
}

/**
 * The surfaces a single view object declares: the `modalities: [...]` array
 * literal when present, otherwise the single `viewType` (default "gui").
 */
function viewObjectModalities(object: string): RoutedViewType[] {
  const modalitiesMatch = object.match(/modalities:\s*\[([^\]]*)\]/);
  if (modalitiesMatch) {
    const mods = [...modalitiesMatch[1].matchAll(/["'](gui|tui|xr)["']/g)].map(
      (m) => m[1] as RoutedViewType,
    );
    if (mods.length > 0) return mods;
  }
  return [(stringField(object, "viewType") ?? "gui") as RoutedViewType];
}

// viewDeclarations() only ever yields declarations whose componentExport is a
// present string (it filters out the rest), so narrow the core type — whose
// componentExport is optional for remote plugins — for these local consumers.
type CoveredView = ViewDeclaration & { componentExport: string };

function viewDeclarations(manifestPath: string): CoveredView[] {
  return viewObjects(readManifest(manifestPath)).flatMap(
    (object): CoveredView[] => {
      const id = stringField(object, "id");
      const label = stringField(object, "label");
      const path = stringField(object, "path");
      const bundlePath = stringField(object, "bundlePath");
      const componentExport = stringField(object, "componentExport");
      if (!id || !label || !bundlePath || !componentExport) return [];
      const surface = object.includes('"agent-surface"')
        ? ({ capabilities: ["agent-surface"] } as const)
        : undefined;
      return viewObjectModalities(object).map((viewType) => ({
        id,
        label,
        ...(path === null ? {} : { path }),
        ...(surface ? { surface } : {}),
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
  req.headers = {
    "x-elizaos-client-id": "plugin-view-inventory-ratchet-client",
  };
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
    broadcastWsToClientId: (_clientId, payload) => {
      broadcastWs?.(payload);
      return broadcastWs ? 1 : 0;
    },
  };
}

async function registerAllManifests(): Promise<{
  pluginNames: string[];
  views: Array<{ manifestPath: string; id: string; path?: string }>;
}> {
  const pluginNames: string[] = [];
  const views: Array<{ manifestPath: string; id: string; path?: string }> = [];
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
      if (declaration.viewType !== "gui") continue;
      views.push({
        manifestPath,
        id: declaration.id,
        path: declaration.path,
      });
    }
  }
  return { pluginNames, views };
}

describe("plugin view coverage", () => {
  it("ships a GUI-only view inventory (no tui/xr declarations)", () => {
    const nonGui: string[] = [];
    for (const manifestPath of VIEW_MANIFESTS) {
      for (const object of viewObjects(readManifest(manifestPath))) {
        const id = stringField(object, "id") ?? "<unknown>";
        for (const modality of viewObjectModalities(object)) {
          if (modality !== "gui") {
            nonGui.push(`${manifestPath}:${id}:${modality}`);
          }
        }
      }
    }
    expect(nonGui).toEqual([]);
  });

  it("can route-switch every bundled plugin view in gui mode", async () => {
    const { pluginNames, views } = await registerAllManifests();
    try {
      expect(views.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const view of views) {
        const broadcasts: object[] = [];
        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/${encodeURIComponent(view.id)}/navigate?viewType=gui`,
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
          event.viewType !== "gui" ||
          event.viewPath !== view.path
        ) {
          failures.push(`${view.manifestPath}:gui:${view.id}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });

  it("can dispatch standard interactions for every bundled plugin view in gui mode", async () => {
    const { pluginNames, views } = await registerAllManifests();
    try {
      expect(views.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const view of views) {
        const broadcasts: object[] = [];
        let resultBody: unknown = null;
        let errorBody: { message: string; status?: number } | null = null;

        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/${encodeURIComponent(view.id)}/interact?viewType=gui`,
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
          event.viewType !== "gui" ||
          event.capability !== "get-state" ||
          result?.success !== true ||
          result.result?.viewId !== view.id ||
          result.result?.viewType !== "gui"
        ) {
          failures.push(`${view.manifestPath}:gui:${view.id}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });

  // The viewType routing contract survives the tui/xr inventory removal:
  // `getView(id, { viewType })` falls back to the gui ("default") declaration
  // when the requested modality has no entry, so tui/xr requests against the
  // gui-only inventory resolve to the gui view — the broadcast and JSON
  // response carry viewType "gui". This is the designed degrade, not an error.
  it("resolves tui/xr navigate requests against the gui-only inventory to the gui view", async () => {
    const { pluginNames, views } = await registerAllManifests();
    try {
      const failures: string[] = [];
      for (const viewType of ["tui", "xr"] as const) {
        for (const view of views) {
          const broadcasts: object[] = [];
          let resultBody: unknown = null;
          let errorBody: { message: string; status?: number } | null = null;
          await handleViewsRoutes(
            makeCtx(
              "POST",
              `/api/views/${encodeURIComponent(view.id)}/navigate?viewType=${viewType}`,
              (payload) => broadcasts.push(payload),
              undefined,
              (_res, body) => {
                resultBody = body;
              },
              (_res, message, status) => {
                errorBody = { message, status };
              },
            ),
          );
          const event = broadcasts[0] as
            | { type?: string; viewId?: string; viewType?: string }
            | undefined;
          const result = resultBody as {
            ok?: boolean;
            viewId?: string;
            viewType?: string;
          } | null;
          if (
            errorBody ||
            event?.type !== "shell:navigate:view" ||
            event.viewId !== view.id ||
            event.viewType !== "gui" ||
            result?.ok !== true ||
            result.viewType !== "gui"
          ) {
            failures.push(`${view.manifestPath}:${viewType}:${view.id}`);
          }
        }
      }
      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });

  it("dispatches tui/xr interact requests against the gui-only inventory as the gui view", async () => {
    const { pluginNames, views } = await registerAllManifests();
    try {
      const failures: string[] = [];
      for (const viewType of ["tui", "xr"] as const) {
        for (const view of views) {
          const broadcasts: object[] = [];
          let resultBody: unknown = null;
          let errorBody: { message: string; status?: number } | null = null;
          await handleViewsRoutes(
            makeCtx(
              "POST",
              `/api/views/${encodeURIComponent(view.id)}/interact?viewType=${viewType}`,
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
                    result: { viewId: event.viewId, viewType: event.viewType },
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
            | { type?: string; viewId?: string; viewType?: string }
            | undefined;
          const result = resultBody as {
            success?: boolean;
            result?: { viewType?: string };
          } | null;
          // The dispatched frame carries the resolved entry's viewType ("gui"),
          // never a fabricated tui/xr surface.
          if (
            errorBody ||
            event?.type !== "view:interact" ||
            event.viewId !== view.id ||
            event.viewType !== "gui" ||
            result?.success !== true ||
            result.result?.viewType !== "gui"
          ) {
            failures.push(`${view.manifestPath}:${viewType}:${view.id}`);
          }
        }
      }
      expect(failures).toEqual([]);
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });

  it("returns the designed 404 for tui/xr interact requests on unknown views", async () => {
    const { pluginNames } = await registerAllManifests();
    try {
      for (const viewType of ["tui", "xr"] as const) {
        let errorBody: { message: string; status?: number } | null = null;
        let resultBody: unknown = null;
        await handleViewsRoutes(
          makeCtx(
            "POST",
            `/api/views/does-not-exist/interact?viewType=${viewType}`,
            () => {},
            { capability: "get-state", timeoutMs: 1_000 },
            (_res, body) => {
              resultBody = body;
            },
            (_res, message, status) => {
              errorBody = { message, status };
            },
          ),
        );
        expect(resultBody).toBeNull();
        expect(errorBody).toEqual({
          message: 'View "does-not-exist" not found',
          status: 404,
        });
      }
    } finally {
      for (const pluginName of pluginNames) unregisterPluginViews(pluginName);
      clearCurrentViewState();
    }
  });
});

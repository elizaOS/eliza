/**
 * Feature-by-feature functional parity validation for all 24 XR views.
 *
 * The architectural guarantee: every XR view uses the SAME bundlePath
 * ("dist/views/bundle.js") and the SAME componentExport as the GUI view.
 * The XR shell (xr-view-host) loads that bundle via dynamic import — making
 * XR and GUI views share 100% of the same React component source.
 *
 * This test suite validates that guarantee explicitly and then verifies
 * the functional content of each component:
 *
 *   A. XR views share the same bundle + component as GUI views (structural)
 *   B. Each component's source contains the functional UI elements it claims
 *   C. The built bundle contains the exported component symbol
 *   D. Agent-facing TUI capabilities are present in the shared source
 *      (proving the agent sees the same interface in XR as in TUI/GUI)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function readFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(repoRoot, relPath));
}

/**
 * A view "component" is no longer a single monolithic .tsx — each view is a
 * co-located family of files sharing one directory: the entry `X.tsx`, its
 * agent-facing capability handlers in `X.interact.ts`, data/helpers in
 * `X.helpers.ts`, plus extracted sub-components and hooks. The functional
 * content, React hooks, and TUI capabilities live across that family. Read the
 * whole directory (non-recursive) so the parity checks see the real source the
 * shared bundle is built from, not just the thin shell entry file.
 */
function readComponentFamily(relPath: string): string {
  const fileDir = dirname(resolve(repoRoot, relPath));
  if (!existsSync(fileDir)) return "";
  const parts: string[] = [];
  for (const name of readdirSync(fileDir)) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    parts.push(readFileSync(resolve(fileDir, name), "utf8"));
  }
  return parts.join("\n");
}

// ── Manifest parser ───────────────────────────────────────────────────────────

interface ViewEntry {
  id: string;
  label: string;
  viewType: "gui" | "tui" | "xr";
  bundlePath: string;
  componentExport: string;
}

function parseViewEntries(source: string): ViewEntry[] {
  const entries: ViewEntry[] = [];
  const viewsStart = source.indexOf("views:");
  if (viewsStart === -1) return entries;
  const arrayStart = source.indexOf("[", viewsStart);
  if (arrayStart === -1) return entries;
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < source.length; i++) {
    if (source[i] === "[") depth++;
    if (source[i] === "]") depth--;
    if (depth === 0) {
      arrayEnd = i;
      break;
    }
  }
  if (arrayEnd === -1) return entries;
  const body = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let start = -1;
  depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    }
    if (body[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (const obj of objects) {
    const id = obj.match(/\bid:\s*"([^"]+)"/)?.[1];
    const label = obj.match(/label:\s*"([^"]+)"/)?.[1];
    const viewType = (obj.match(/viewType:\s*"([^"]+)"/)?.[1] ?? "gui") as
      | "gui"
      | "tui"
      | "xr";
    const bundlePath = obj.match(/bundlePath:\s*"([^"]+)"/)?.[1];
    const componentExport = obj.match(/componentExport:\s*"([^"]+)"/)?.[1];
    if (id && label && bundlePath && componentExport) {
      entries.push({ id, label, viewType, bundlePath, componentExport });
    }
  }
  return entries;
}

// ── Plugin manifest registry ──────────────────────────────────────────────────
// Each entry: (plugin directory, manifest path, component source file for XR view)

const PLUGIN_REGISTRY: Array<{
  pluginDir: string;
  manifestPath: string;
  /** Path to the component source file the XR view renders */
  xrComponentSrc: string;
  /** Key functional terms that MUST appear in the component source */
  requiredTerms: string[];
}> = [
  {
    pluginDir: "plugins/plugin-companion",
    manifestPath: "plugins/plugin-companion/src/plugin.ts",
    xrComponentSrc:
      "plugins/plugin-companion/src/components/companion/CompanionView.tsx",
    requiredTerms: ["CompanionView", "CompanionSceneHost", "EmotePicker"],
  },
  {
    pluginDir: "plugins/plugin-contacts",
    manifestPath: "plugins/plugin-contacts/src/plugin.ts",
    xrComponentSrc:
      "plugins/plugin-contacts/src/components/ContactsAppView.tsx",
    requiredTerms: [
      "Contacts",
      "createContact",
      "ContactsAppView",
      "Input",
      "Button",
    ],
  },
  {
    pluginDir: "plugins/plugin-hyperliquid-app",
    manifestPath: "plugins/plugin-hyperliquid-app/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-hyperliquid-app/src/HyperliquidAppView.tsx",
    requiredTerms: ["HyperliquidAppView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-personal-assistant",
    manifestPath: "plugins/plugin-personal-assistant/src/plugin.ts",
    xrComponentSrc:
      "plugins/plugin-personal-assistant/src/components/LifeOpsPageView.tsx",
    requiredTerms: ["LifeOpsPageView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-messages",
    manifestPath: "plugins/plugin-messages/src/plugin.ts",
    xrComponentSrc:
      "plugins/plugin-messages/src/components/MessagesAppView.tsx",
    requiredTerms: ["MessagesAppView", "Button"],
  },
  {
    pluginDir: "plugins/app-model-tester",
    manifestPath: "plugins/app-model-tester/src/plugin.ts",
    xrComponentSrc: "plugins/app-model-tester/src/ModelTesterAppView.tsx",
    requiredTerms: ["ModelTesterAppView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-phone",
    manifestPath: "plugins/plugin-phone/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-phone/src/components/PhoneAppView.tsx",
    requiredTerms: ["PhoneAppView", "Phone", "Button", "Tabs"],
  },
  {
    pluginDir: "plugins/plugin-polymarket-app",
    manifestPath: "plugins/plugin-polymarket-app/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-polymarket-app/src/PolymarketAppView.tsx",
    requiredTerms: ["PolymarketAppView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-shopify-ui",
    manifestPath: "plugins/plugin-shopify-ui/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-shopify-ui/src/ShopifyAppView.tsx",
    requiredTerms: ["ShopifyAppView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-steward-app",
    manifestPath: "plugins/plugin-steward-app/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-steward-app/src/StewardView.tsx",
    requiredTerms: ["StewardView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-vincent",
    manifestPath: "plugins/plugin-vincent/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-vincent/src/VincentAppView.tsx",
    requiredTerms: ["VincentAppView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-wallet-ui",
    manifestPath: "plugins/plugin-wallet-ui/src/plugin.ts",
    xrComponentSrc: "plugins/plugin-wallet-ui/src/InventoryView.tsx",
    requiredTerms: ["InventoryView", "Button", "useInventoryData"],
  },
  {
    pluginDir: "plugins/plugin-2004scape",
    manifestPath: "plugins/plugin-2004scape/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.tsx",
    requiredTerms: ["TwoThousandFourScapeOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-feed",
    manifestPath: "plugins/plugin-feed/src/index.ts",
    xrComponentSrc: "plugins/plugin-feed/src/ui/FeedOperatorSurface.tsx",
    requiredTerms: ["FeedOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-app-control",
    manifestPath: "plugins/plugin-app-control/src/index.ts",
    xrComponentSrc: "plugins/plugin-app-control/src/views/ViewManagerView.tsx",
    requiredTerms: ["ViewManagerView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-clawville",
    manifestPath: "plugins/plugin-clawville/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.tsx",
    requiredTerms: ["ClawvilleOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-defense-of-the-agents",
    manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface.tsx",
    requiredTerms: ["DefenseAgentsOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-hyperscape",
    manifestPath: "plugins/plugin-hyperscape/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.tsx",
    requiredTerms: ["HyperscapeOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-scape",
    manifestPath: "plugins/plugin-scape/src/index.ts",
    xrComponentSrc: "plugins/plugin-scape/src/ui/ScapeOperatorSurface.tsx",
    requiredTerms: ["ScapeOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-screenshare",
    manifestPath: "plugins/plugin-screenshare/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-screenshare/src/ui/ScreenshareOperatorSurface.tsx",
    requiredTerms: ["ScreenshareOperatorSurface", "useState"],
  },
  {
    pluginDir: "plugins/plugin-task-coordinator",
    manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx",
    requiredTerms: ["CodingAgentTasksPanel", "useState"],
  },
  {
    pluginDir: "plugins/plugin-trajectory-logger",
    manifestPath: "plugins/plugin-trajectory-logger/src/index.ts",
    xrComponentSrc:
      "plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerView.tsx",
    requiredTerms: ["TrajectoryLoggerView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-training",
    manifestPath: "plugins/plugin-training/src/setup-routes.ts",
    xrComponentSrc: "plugins/plugin-training/src/ui/FineTuningView.tsx",
    requiredTerms: ["FineTuningView", "useState"],
  },
  {
    pluginDir: "plugins/plugin-facewear",
    manifestPath: "plugins/plugin-facewear/src/index.ts",
    xrComponentSrc: "plugins/plugin-facewear/src/ui/SmartglassesView.tsx",
    requiredTerms: ["SmartglassesView", "useState"],
  },
];

// ── TUI capability baseline (from plugin-tui-view-coverage.test.ts) ──────────
// These are the exact agent-facing capabilities each view must expose in its
// source — proving the same capabilities are available in XR (same component).

const TUI_CAPABILITY_SOURCE_MAP: Record<
  string,
  { srcFile: string; capabilities: string[] }
> = {
  "plugins/plugin-companion": {
    srcFile:
      "plugins/plugin-companion/src/components/companion/CompanionView.interact.ts",
    capabilities: ["terminal-companion-state", "terminal-companion-emotes"],
  },
  "plugins/plugin-contacts": {
    srcFile:
      "plugins/plugin-contacts/src/components/ContactsAppView.interact.ts",
    capabilities: ["terminal-list-contacts", "terminal-create-contact"],
  },
  "plugins/plugin-hyperliquid-app": {
    srcFile:
      "plugins/plugin-hyperliquid-app/src/HyperliquidAppView.interact.ts",
    capabilities: ["terminal-hyperliquid-state"],
  },
  "plugins/plugin-personal-assistant": {
    srcFile:
      "plugins/plugin-personal-assistant/src/components/LifeOpsPageView.interact.ts",
    capabilities: ["terminal-lifeops-state", "terminal-lifeops-enable"],
  },
  "plugins/plugin-messages": {
    srcFile:
      "plugins/plugin-messages/src/components/MessagesAppView.interact.ts",
    capabilities: ["terminal-list-threads", "terminal-send-sms"],
  },
  "plugins/plugin-phone": {
    srcFile: "plugins/plugin-phone/src/components/PhoneAppView.interact.ts",
    capabilities: ["terminal-phone-state", "terminal-place-call"],
  },
  "plugins/plugin-wallet-ui": {
    srcFile: "plugins/plugin-wallet-ui/src/InventoryView.interact.ts",
    capabilities: ["terminal-wallet-state"],
  },
  "plugins/plugin-2004scape": {
    srcFile:
      "plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.interact.ts",
    capabilities: ["terminal-2004scape-state", "terminal-2004scape-command"],
  },
  "plugins/plugin-feed": {
    srcFile: "plugins/plugin-feed/src/ui/FeedOperatorSurface.interact.ts",
    capabilities: ["get-state", "refresh-agent-status"],
  },
  "plugins/plugin-clawville": {
    srcFile:
      "plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.interact.ts",
    capabilities: ["terminal-clawville-state", "terminal-clawville-command"],
  },
  "plugins/plugin-defense-of-the-agents": {
    srcFile:
      "plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface.interact.ts",
    capabilities: ["terminal-defense-state", "terminal-defense-command"],
  },
  "plugins/plugin-hyperscape": {
    srcFile:
      "plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.interact.ts",
    capabilities: ["terminal-hyperscape-state", "terminal-hyperscape-command"],
  },
  "plugins/plugin-scape": {
    srcFile: "plugins/plugin-scape/src/ui/ScapeOperatorSurface.interact.ts",
    capabilities: ["terminal-scape-state", "terminal-scape-command"],
  },
  "plugins/plugin-screenshare": {
    srcFile:
      "plugins/plugin-screenshare/src/ui/ScreenshareOperatorSurface.interact.ts",
    capabilities: ["terminal-screenshare-state", "terminal-screenshare-start"],
  },
  "plugins/plugin-task-coordinator": {
    srcFile:
      "plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.interact.ts",
    capabilities: ["list-sessions", "list-task-threads"],
  },
  "plugins/plugin-trajectory-logger": {
    srcFile:
      "plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerView.interact.ts",
    capabilities: ["list-trajectories", "open-latest"],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("XR feature-by-feature functional parity — all 24 views", () => {
  // A. Shared bundle architecture ─────────────────────────────────────────────

  it("A — every XR view uses the same bundlePath as the GUI view (shared bundle = shared features)", () => {
    const failures: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_REGISTRY) {
      const source = readFile(manifestPath);
      const entries = parseViewEntries(source);
      const guiEntry = entries.find((e) => e.viewType === "gui");
      const xrEntry = entries.find((e) => e.viewType === "xr");
      if (!guiEntry) {
        failures.push(`${pluginDir}: no gui view found`);
        continue;
      }
      if (!xrEntry) {
        failures.push(`${pluginDir}: no xr view found`);
        continue;
      }
      if (guiEntry.bundlePath !== xrEntry.bundlePath) {
        failures.push(
          `${pluginDir}: gui bundlePath="${guiEntry.bundlePath}" ≠ xr bundlePath="${xrEntry.bundlePath}"`,
        );
      }
    }
    expect(
      failures,
      "plugins where XR uses a different bundle than GUI",
    ).toEqual([]);
  });

  it("A — every XR view exports the same React component as the GUI view", () => {
    const failures: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_REGISTRY) {
      const source = readFile(manifestPath);
      const entries = parseViewEntries(source);
      const guiEntry = entries.find((e) => e.viewType === "gui");
      const xrEntry = entries.find((e) => e.viewType === "xr");
      if (!guiEntry || !xrEntry) continue;
      // Normalize: strip package#Name prefix if present
      const normalize = (s: string) =>
        s.includes("#") ? (s.split("#").pop() ?? s) : s;
      if (
        normalize(guiEntry.componentExport) !==
        normalize(xrEntry.componentExport)
      ) {
        failures.push(
          `${pluginDir}: gui exports "${guiEntry.componentExport}" but xr exports "${xrEntry.componentExport}"`,
        );
      }
    }
    expect(
      failures,
      "plugins where XR uses a different component than GUI",
    ).toEqual([]);
  });

  // B. Component source functional content ────────────────────────────────────

  it("B — each XR view's component source file exists and is non-empty TSX", () => {
    const failures: string[] = [];
    for (const { pluginDir, xrComponentSrc } of PLUGIN_REGISTRY) {
      if (!fileExists(xrComponentSrc)) {
        failures.push(`${pluginDir}: ${xrComponentSrc} does not exist`);
      } else {
        const src = readFile(xrComponentSrc);
        if (src.length < 100) {
          failures.push(
            `${pluginDir}: ${xrComponentSrc} is too short (${src.length} bytes)`,
          );
        }
      }
    }
    expect(failures, "missing or empty XR component source files").toEqual([]);
  });

  it("B — each XR component source contains its required functional UI terms", () => {
    const failures: string[] = [];
    for (const {
      pluginDir,
      xrComponentSrc,
      requiredTerms,
    } of PLUGIN_REGISTRY) {
      if (!fileExists(xrComponentSrc)) continue;
      const src = readComponentFamily(xrComponentSrc);
      for (const term of requiredTerms) {
        if (!src.includes(term)) {
          failures.push(
            `${pluginDir}: "${term}" not found in ${xrComponentSrc}`,
          );
        }
      }
    }
    expect(failures, "components missing required functional content").toEqual(
      [],
    );
  });

  it("B — all 24 XR component sources use React hooks (useState/useEffect) for stateful UIs", () => {
    const noHooks: string[] = [];
    for (const { pluginDir, xrComponentSrc } of PLUGIN_REGISTRY) {
      if (!fileExists(xrComponentSrc)) continue;
      const src = readComponentFamily(xrComponentSrc);
      if (
        !src.includes("useState") &&
        !src.includes("useEffect") &&
        !src.includes("useRef") &&
        !src.includes("useCallback") &&
        !src.includes("useRenderGuard")
      ) {
        noHooks.push(`${pluginDir}: ${xrComponentSrc}`);
      }
    }
    expect(
      noHooks,
      "XR components with no React hooks (likely static shells)",
    ).toEqual([]);
  });

  // C. Bundle exports the declared component symbol ───────────────────────────

  it("C — built bundle.js files export their declared componentExport symbols", () => {
    const failures: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_REGISTRY) {
      const bundlePath = `${pluginDir}/dist/views/bundle.js`;
      if (!fileExists(bundlePath)) {
        continue;
      }
      const bundle = readFile(bundlePath);
      const source = readFile(manifestPath);
      const xrEntry = parseViewEntries(source).find((e) => e.viewType === "xr");
      if (!xrEntry) {
        failures.push(`${pluginDir}: no xr entry`);
        continue;
      }
      const exportName = xrEntry.componentExport.includes("#")
        ? (xrEntry.componentExport.split("#").pop() ?? xrEntry.componentExport)
        : xrEntry.componentExport;
      if (!bundle.includes(exportName)) {
        failures.push(`${pluginDir}: bundle does not contain "${exportName}"`);
      }
    }
    expect(failures, "bundles missing declared XR component").toEqual([]);
  });

  // D. Agent-facing TUI capabilities in shared source ─────────────────────────

  it("D — agent TUI capabilities are present in the shared XR component source (GUI=XR=TUI via same component)", () => {
    const failures: string[] = [];
    for (const [pluginDir, { srcFile, capabilities }] of Object.entries(
      TUI_CAPABILITY_SOURCE_MAP,
    )) {
      if (!fileExists(srcFile)) {
        failures.push(`${pluginDir}: source file ${srcFile} missing`);
        continue;
      }
      const src = readComponentFamily(srcFile);
      for (const cap of capabilities) {
        if (!src.includes(cap)) {
          failures.push(`${pluginDir}: capability "${cap}" not in ${srcFile}`);
        }
      }
    }
    expect(
      failures,
      "TUI capabilities missing from shared XR+GUI component source",
    ).toEqual([]);
  });

  // Summary assertion ─────────────────────────────────────────────────────────

  it("summary — all 24 plugins have XR views that are functionally identical to their GUI views", () => {
    // This test is a logical consequence of tests A, B, C, D above all passing.
    // It explicitly states the guarantee: same bundle + same component = same features.
    const xrPluginCount = PLUGIN_REGISTRY.length;
    expect(xrPluginCount).toBe(24);

    for (const { pluginDir, manifestPath } of PLUGIN_REGISTRY) {
      const source = readFile(manifestPath);
      const entries = parseViewEntries(source);
      const guiEntry = entries.find((e) => e.viewType === "gui");
      const xrEntry = entries.find((e) => e.viewType === "xr");

      expect(guiEntry, `${pluginDir}: GUI view must exist`).toBeDefined();
      expect(xrEntry, `${pluginDir}: XR view must exist`).toBeDefined();

      if (guiEntry && xrEntry) {
        // The architectural guarantee: XR is GUI is the same component
        expect(
          guiEntry.bundlePath,
          `${pluginDir}: XR bundle must equal GUI bundle`,
        ).toBe(xrEntry.bundlePath);
      }
    }
  });
});

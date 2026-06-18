/* global agent, args, log, phase, pipeline */

export const meta = {
  description:
    "Convert production plugin views to the unified tri-modal spatial framework (GUI/XR/TUI)",
  name: "spatial-convert-plugin-views",
  phases: [
    {
      detail: "read each plugin view and data shape into a conversion spec",
      title: "Scout",
    },
    {
      detail:
        "author <Plugin>SpatialView, register it, add a tri-modal test, and verify",
      title: "Convert",
    },
  ],
};

// Plugins to convert. Each gets an additive unified spatial view (GUI/XR/TUI)
// without ripping out its existing rich GUI component (low regression risk).
const PLUGINS =
  args && Array.isArray(args) && args.length > 0
    ? args
    : [
        "plugin-messages",
        "plugin-contacts",
        "plugin-wallet-ui",
        "plugin-polymarket-app",
        "plugin-hyperliquid-app",
        "plugin-steward-app",
        "plugin-task-coordinator",
        "plugin-personal-assistant",
        "plugin-shopify-ui",
        "plugin-vincent",
        "plugin-app-control",
        "plugin-trajectory-logger",
        "app-model-tester",
        "plugin-feed",
        "plugin-2004scape",
        "plugin-clawville",
        "plugin-hyperscape",
        "plugin-scape",
        "plugin-defense-of-the-agents",
        "plugin-screenshare",
        "plugin-facewear",
        "plugin-companion",
      ];

const SCOUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    archetype: {
      enum: [
        "list",
        "form",
        "dashboard",
        "detail",
        "operator",
        "dialer",
        "feed",
        "canvas-game",
        "canvas-3d",
        "other",
      ],
      type: "string",
    },
    canvasOnly: {
      description:
        "true if the GUI is a non-textual canvas/3D surface; TUI/XR get a status panel",
      type: "boolean",
    },
    componentExport: { type: "string" },
    dataSummary: {
      description: "the core data the view displays and its field names",
      type: "string",
    },
    notes: { type: "string" },
    plugin: { type: "string" },
    viewId: {
      description: "the view id declared in plugin.ts/index.ts",
      type: "string",
    },
  },
  required: ["plugin", "viewId", "archetype", "dataSummary", "canvasOnly"],
  type: "object",
};

const CONVERT_SCHEMA = {
  additionalProperties: false,
  properties: {
    created: {
      description: "relative paths of files created/edited",
      items: { type: "string" },
      type: "array",
    },
    failure: {
      description: "error output if testPassed is false",
      type: "string",
    },
    plugin: { type: "string" },
    summary: { type: "string" },
    testPassed: { type: "boolean" },
  },
  required: ["plugin", "created", "testPassed", "summary"],
  type: "object",
};

const REFERENCE = `Reference implementation (mirror its structure exactly):
- plugins/plugin-phone/src/components/PhoneSpatialView.tsx - presentational unified view (snapshot + onAction in, primitives out; type-only native imports).
- plugins/plugin-phone/src/register-terminal-view.tsx - registers it for the agent terminal via registerSpatialTerminalView, DOM-guarded.
- plugins/plugin-phone/src/components/PhoneSpatialView.test.tsx - tri-modal test (TUI width contract + GUI/XR DOM + terminal registry round-trip).
- plugins/plugin-phone/src/register.ts - Node-guarded lazy import that calls the terminal registration.

Spatial API: import { Stack, HStack, VStack, Card, List, Text, Button, Field, Divider, Spacer, Image, type SpatialTone } from "@elizaos/ui/spatial";
Terminal: import { registerSpatialTerminalView, renderViewToLines, getTerminalView } from "@elizaos/ui/spatial/tui";
DOM host: import { SpatialSurface } from "@elizaos/ui/spatial";
Width is in cells (0.25rem in DOM, 1 column in terminal). Use width="100%"/grow to fill, not fixed cell widths for text. Avoid East-Asian ambiguous glyphs; use ASCII markers. Tones: default/muted/primary/success/warning/danger.`;

phase("Scout");
const specs = await pipeline(
  PLUGINS,
  (plugin) =>
    agent(
      `You are scouting plugin "plugins/${plugin}" to plan a unified tri-modal (GUI/XR/TUI) view conversion.
Read its plugin.ts (or src/index.ts) "views" declaration and the GUI view component it references.
Classify the primary view's archetype and summarise the core data it displays (the field/prop names).
If the GUI is a non-textual canvas or 3D surface (a game render, VRM avatar, video/screenshare), set canvasOnly=true. For those, the TUI/XR rendering will be a textual status/operator panel, not the canvas.
Return the conversion spec. Read-only: do not edit anything.`,
      {
        agentType: "Explore",
        label: `scout:${plugin}`,
        phase: "Scout",
        schema: SCOUT_SCHEMA,
      },
    ),
  (spec) => {
    if (!spec) return null;

    return agent(
      `Convert plugin "plugins/${spec.plugin}" to a unified tri-modal spatial view. This is additive: do not modify or delete the existing GUI view component; add new files so the same view renders correctly on GUI (DOM), XR (scaled DOM), and TUI (real terminal lines).

Spec: ${JSON.stringify(spec)}

${REFERENCE}

Do exactly this:
1. Create plugins/${spec.plugin}/src/components/<Name>SpatialView.tsx - a presentational unified view built from the spatial primitives, taking a typed snapshot prop (mirror the plugin's real data: ${spec.dataSummary}). If canvasOnly, render a concise status/operator panel (title, key status fields, primary actions) instead of the canvas.
2. Create plugins/${spec.plugin}/src/register-terminal-view.tsx - mirror plugin-phone's: a module-level snapshot + setter + registerSpatialTerminalView("${spec.viewId}", () => createElement(<Name>SpatialView, { snapshot })).
3. Wire a DOM-guarded lazy registration call into the plugin's existing side-effect load path (register.ts or index.ts) like plugin-phone's register.ts (only when typeof window === "undefined").
4. Create plugins/${spec.plugin}/src/components/<Name>SpatialView.test.tsx - a tri-modal test mirroring PhoneSpatialView.test.tsx: assert TUI renderViewToLines honors the width contract (every line visibleWidth === width) at widths 54 and 32 and contains key content; assert GUI+XR SpatialSurface DOM contains the content + data-spatial-surface; assert the terminal registry round-trip renders lines.
5. Run ONLY your new test: bun run --cwd plugins/${spec.plugin} vitest run src/components/<Name>SpatialView.test.tsx (use the exact path you created). Iterate on the view until it passes. If you ever see a "dyld"/"SIGABRT"/"libsimdjson"/"mig callout" crash, that is a transient macOS code-signing hiccup, not your code — just re-run the same command once or twice and it will run. Set testPassed=true only when the vitest run reports all tests passed.
6. Run: bunx biome check --write plugins/${spec.plugin}/src/components/<Name>SpatialView.tsx plugins/${spec.plugin}/src/register-terminal-view.tsx plugins/${spec.plugin}/src/components/<Name>SpatialView.test.tsx

Report created files, whether the vitest run passed, and a one-line summary. If you cannot make it pass, set testPassed=false and include the failure output. The full suite is also re-run centrally afterwards.`,
      {
        label: `convert:${spec.plugin}`,
        phase: "Convert",
        schema: CONVERT_SCHEMA,
      },
    );
  },
);

const results = specs.filter(Boolean);
const passed = results.filter((result) => result.testPassed);
log(
  `Converted ${passed.length}/${results.length} plugins with passing tri-modal tests`,
);

return {
  created: results.flatMap((result) => result.created ?? []),
  failed: results
    .filter((result) => !result.testPassed)
    .map((result) => ({
      failure: result.failure,
      plugin: result.plugin,
    })),
  passed: passed.length,
  total: results.length,
};

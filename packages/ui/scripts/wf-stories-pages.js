export const meta = {
  name: "add-ui-stories-pages",
  description: "Add Storybook stories using the mock-provider harness",
  phases: [{ title: "Write stories" }],
};

const targets = ["src/components/pages/AppDetailsView.tsx","src/components/pages/AppsPageView.tsx","src/components/pages/AppsView.tsx","src/components/pages/AutomationsFeed.tsx","src/components/pages/BrowserWorkspaceView.tsx","src/components/pages/ChatView.tsx","src/components/pages/ConfigPageView.tsx","src/components/pages/DatabasePageView.tsx","src/components/pages/DatabaseView.tsx","src/components/pages/DocumentsView.tsx","src/components/pages/ElizaCloudDashboard.tsx","src/components/pages/ElizaOsAppsView.tsx","src/components/pages/GeneratedViewHero.tsx","src/components/pages/HeartbeatForm.tsx","src/components/pages/HeartbeatsView.tsx","src/components/pages/LogsView.tsx","src/components/pages/MediaGalleryView.tsx","src/components/pages/MemoryDetailPanel.tsx","src/components/pages/MemoryViewerView.tsx","src/components/pages/PageScopedChatPane.tsx","src/components/pages/PluginCard.tsx","src/components/pages/PluginConfigForm.tsx","src/components/pages/PluginVisual.tsx","src/components/pages/PluginsPageView.tsx","src/components/pages/PluginsView.tsx","src/components/pages/RelationshipsGraphPanel.tsx","src/components/pages/RelationshipsIdentityCluster.tsx","src/components/pages/RelationshipsView.tsx","src/components/pages/ReleaseCenterView.tsx","src/components/pages/RuntimeView.tsx","src/components/pages/SecretsView.tsx","src/components/pages/SettingsView.tsx","src/components/pages/SkillsView.tsx","src/components/pages/SqlEditorPanel.tsx","src/components/pages/StreamView.tsx","src/components/pages/TaskEditor.tsx","src/components/pages/TasksPageView.tsx","src/components/pages/TrajectoriesView.tsx","src/components/pages/TrajectoryDetailView.tsx","src/components/pages/ViewCatalog.tsx","src/components/pages/WorkflowEditor.tsx","src/components/pages/WorkflowGraphViewer.tsx","src/components/pages/config-page-sections.tsx","src/components/pages/documents-detail.tsx","src/components/pages/documents-upload.tsx","src/components/pages/plugin-view-connectors.tsx","src/components/pages/plugin-view-dialogs.tsx","src/components/pages/plugin-view-modal.tsx","src/components/pages/plugin-view-sidebar.tsx","src/components/pages/relationships/RelationshipsActivityFeed.tsx","src/components/pages/relationships/RelationshipsCandidateMergesPanel.tsx","src/components/pages/relationships/RelationshipsPersonPanels.tsx","src/components/pages/relationships/RelationshipsSidebar.tsx","src/components/pages/relationships/RelationshipsWorkspaceView.tsx","src/components/pages/skill-detail-panel.tsx","src/components/pages/skill-marketplace.tsx"];
const batchName = "pages";

phase("Write stories");

const RESULT_SCHEMA = {
  type: "object",
  required: ["file", "status"],
  additionalProperties: false,
  properties: {
    file: { type: "string" },
    status: { enum: ["written", "skipped", "already-exists"] },
    storyPath: { type: "string" },
    skipReason: { type: "string" },
    notes: { type: "string" },
  },
};

const buildPrompt = (target) => {
  const storyPath = target.replace(/\.tsx$/, ".stories.tsx");
  return `Add a Storybook (CSF 3) story for the component at packages/ui/${target}.

This is @elizaos/ui — React + Tailwind, Storybook on @storybook/react + Vite (CSF 3).

CRITICAL — there is a MOCK PROVIDER HARNESS you MUST use for state-coupled components:
  packages/ui/src/storybook/mock-providers.helpers.tsx exports:
    - \`withMockApp\`  — Decorator that wraps the story in BOTH AppContext (useApp) AND TranslationCtx (useTranslation). The mock app context is a Proxy: every field not explicitly set returns a no-op function, so calling any handler is safe. agentStatus, navigation, t, uiLanguage etc. are pre-populated.
    - \`mockApp({ ... })\` — same, but lets you override specific AppContext fields (e.g. mockApp({ agentStatus: { state: "running" } })).
    - \`withMockTranslation\` — Decorator providing only useTranslation (lighter; use when the component only needs \`t\`).
  Import it with the correct RELATIVE path from the story's location. Compute the depth:
    - src/components/<area>/Foo.stories.tsx  -> "../../storybook/mock-providers.helpers"
    - src/components/<area>/<sub>/Foo.stories.tsx -> "../../../storybook/mock-providers.helpers"
    - src/components/pages/relationships/Foo.stories.tsx -> "../../../../storybook/mock-providers.helpers"
    - src/<area>/Foo.stories.tsx (e.g. src/layouts/..., src/first-run/...) -> compute accordingly.
  Attach via \`decorators: [withMockApp]\` (or \`decorators: [mockApp({...})]\`) on the meta, or per-story.

The api \`client\` exists but has NO backend in Storybook — calls reject/hang. So:
  - Components that fetch data in useEffect on mount are STILL story-able: they will render their LOADING or EMPTY state. That is a valid, useful story. DO NOT skip for this reason.
  - Only a synchronous deref of an API result during render would crash — check for that.

Conventions:
- Story lives next to the component: packages/ui/${storyPath}
- Title: top dir under src/ (or under components/) -> CapitalCase, then slash path. Examples:
    components/pages/SettingsView.tsx -> "Pages/SettingsView"
    components/settings/ProviderCard.tsx -> "Settings/ProviderCard"
    components/shell/Header.tsx -> "Shell/Header"
    components/pages/relationships/RelationshipsSidebar.tsx -> "Pages/Relationships/RelationshipsSidebar"
    layouts/page-layout/page-layout.tsx -> "Layouts/PageLayout"
    first-run/FirstRunScreen.tsx -> "FirstRun/FirstRunScreen"
- Canonical simple example: packages/ui/src/components/composites/chat/chat-bubble.stories.tsx
- An example USING the harness already exists, e.g. packages/ui/src/components/release-center/sections.stories.tsx and src/components/custom-actions/CustomActionEditor.stories.tsx — read one to match the decorator style.

Steps:
1. Read packages/ui/${target} fully. Note exports, props, and which contexts/hooks it uses (useApp / useTranslation / useAgentElement / three.js / native bridge).
2. Pick the right export to story (if the file exports several, story the primary one; you may add a couple stories for siblings).
3. Decide story-ability:
   - Story-able (the COMMON case): wrap with withMockApp (or mockApp overrides) and render Default + 2-4 meaningful variants/states (loading, empty, error, populated-via-props, variant prop). Pass props directly where the component accepts them.
   - SKIP only if: the component requires a live WebGL/<canvas> 3D context (three.js / VRM / pixi) that cannot render headless, OR it synchronously throws at module-load/render even under withMockApp, OR it is a pure provider/registry with no visual output. Return status="skipped" with a precise skipReason.
4. If story-able, WRITE packages/ui/${storyPath}. Keep under ~140 lines. Use realistic placeholder strings; placehold.co for images; \`() => {}\` for handlers (do NOT import @storybook/test).
5. Use relative imports for the component (./Name). Never import the component from the @elizaos/ui barrel.

Return JSON matching the schema. Set "file" to "${target}". Use status="written" (+storyPath), "skipped" (+skipReason), or "already-exists".

Rules: do NOT modify the component source or any index.ts; do NOT run bun/storybook.`;
};

const results = await parallel(
  targets.map((target) => () =>
    agent(buildPrompt(target), {
      label: `${batchName}:${target.split("/").slice(-1)[0]}`,
      schema: RESULT_SCHEMA,
    }),
  ),
);

const written = results.filter((r) => r && r.status === "written").length;
const skipped = results.filter((r) => r && r.status === "skipped").length;
const exists = results.filter((r) => r && r.status === "already-exists").length;
const nulls = results.filter((r) => !r).length;

log(
  `[${batchName}] written=${written} skipped=${skipped} exists=${exists} errors=${nulls}`,
);

return {
  batchName,
  written,
  skipped,
  alreadyExists: exists,
  errors: nulls,
  skippedFiles: results
    .filter((r) => r && r.status === "skipped")
    .map((r) => ({ file: r.file, reason: r.skipReason })),
};

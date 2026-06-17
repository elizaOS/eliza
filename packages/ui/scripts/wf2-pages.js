export const meta = {
  name: "add-ui-stories-v2-pages",
  description: "Add Storybook stories using the mock-provider harness (no-schema)",
  phases: [{ title: "Write stories" }],
};

const targets = ["src/components/pages/HeartbeatForm.tsx","src/components/pages/HeartbeatsView.tsx","src/components/pages/LogsView.tsx","src/components/pages/MediaGalleryView.tsx","src/components/pages/MemoryDetailPanel.tsx","src/components/pages/MemoryViewerView.tsx","src/components/pages/PageScopedChatPane.tsx","src/components/pages/PluginCard.tsx","src/components/pages/PluginConfigForm.tsx","src/components/pages/PluginVisual.tsx","src/components/pages/PluginsPageView.tsx","src/components/pages/PluginsView.tsx","src/components/pages/RelationshipsGraphPanel.tsx","src/components/pages/RelationshipsIdentityCluster.tsx","src/components/pages/RelationshipsView.tsx","src/components/pages/ReleaseCenterView.tsx","src/components/pages/RuntimeView.tsx","src/components/pages/SecretsView.tsx","src/components/pages/SettingsView.tsx","src/components/pages/SkillsView.tsx","src/components/pages/SqlEditorPanel.tsx","src/components/pages/StreamView.tsx","src/components/pages/TaskEditor.tsx","src/components/pages/TasksPageView.tsx","src/components/pages/TrajectoriesView.tsx","src/components/pages/TrajectoryDetailView.tsx","src/components/pages/ViewCatalog.tsx","src/components/pages/WorkflowEditor.tsx","src/components/pages/WorkflowGraphViewer.tsx","src/components/pages/config-page-sections.tsx","src/components/pages/documents-detail.tsx","src/components/pages/documents-upload.tsx","src/components/pages/plugin-view-connectors.tsx","src/components/pages/plugin-view-dialogs.tsx","src/components/pages/plugin-view-modal.tsx","src/components/pages/plugin-view-sidebar.tsx","src/components/pages/relationships/RelationshipsActivityFeed.tsx","src/components/pages/relationships/RelationshipsCandidateMergesPanel.tsx","src/components/pages/relationships/RelationshipsPersonPanels.tsx","src/components/pages/relationships/RelationshipsSidebar.tsx","src/components/pages/relationships/RelationshipsWorkspaceView.tsx","src/components/pages/skill-detail-panel.tsx","src/components/pages/skill-marketplace.tsx"];
const batchName = "pages";

phase("Write stories");

const buildPrompt = (target) => {
  const storyPath = target.replace(/\.tsx$/, ".stories.tsx");
  return `Write a Storybook (CSF 3) story FILE for the component at packages/ui/${target}.

Your ONLY deliverable is the written file. Use the Write tool to create packages/ui/${storyPath}. Then reply with one short line ("written" or "skipped: <reason>"). Do NOT ask questions.

This is @elizaos/ui — React + Tailwind, Storybook on @storybook/react + Vite (CSF 3).

USE THE MOCK PROVIDER HARNESS for any component that reads app state or i18n:
  packages/ui/src/storybook/mock-providers.helpers.tsx exports:
    - withMockApp  — Decorator wrapping the story in BOTH AppContext (useApp) AND TranslationCtx (useTranslation). The app context is a Proxy: any unset field returns a no-op fn, so handlers are safe to call.
    - mockApp({ ... }) — same, with specific AppContext overrides (e.g. mockApp({ agentStatus: { state: "running" } })).
    - withMockTranslation — only the i18n context (useTranslation).
  Import with the RIGHT relative path from the story location:
    - src/components/<area>/Foo.stories.tsx          -> "../../storybook/mock-providers.helpers"
    - src/components/<area>/<sub>/Foo.stories.tsx     -> "../../../storybook/mock-providers.helpers"
    - src/components/pages/relationships/Foo.stories.tsx -> "../../../../storybook/mock-providers.helpers"
    - src/<area>/Foo.stories.tsx (e.g. layouts/, first-run/, genui/, widgets/, backgrounds/) -> compute depth.
  Attach via \`decorators: [withMockApp]\` on the meta.

The api \`client\` has NO backend in Storybook — calls reject/hang. Components that fetch on mount STILL render their loading/empty state — that is a fine story. Do NOT skip for that. Only skip if the component needs a live WebGL/<canvas> 3D context (three.js/VRM/pixi) or throws synchronously at render even under withMockApp.

Title convention: top dir under src/ (or components/) -> CapitalCase, then slash path:
   components/pages/SettingsView.tsx -> "Pages/SettingsView"
   components/settings/ProviderCard.tsx -> "Settings/ProviderCard"
   components/pages/relationships/RelationshipsSidebar.tsx -> "Pages/Relationships/RelationshipsSidebar"
   layouts/page-layout/page-layout.tsx -> "Layouts/PageLayout"
   first-run/FirstRunScreen.tsx -> "FirstRun/FirstRunScreen"

Read for style: packages/ui/src/components/release-center/sections.stories.tsx (uses the harness) and packages/ui/src/components/composites/chat/chat-bubble.stories.tsx (plain).

Requirements for the file:
- One default meta { title, component, tags: ['autodocs'], decorators: [withMockApp] (if needed) }.
- Default export = meta; then 2-5 named story exports (Default + meaningful variants/states).
- Pass props directly where the component accepts them; use () => {} for handlers (never import @storybook/test).
- Realistic placeholder strings; placehold.co for images.
- Relative import of the component (./Name), NEVER from the @elizaos/ui barrel.
- Keep under ~140 lines. Valid TypeScript/TSX.

Steps: (1) Read packages/ui/${target}; (2) decide; (3) Write packages/ui/${storyPath} (or skip per the narrow rule); (4) reply one line.
Do NOT modify the component source or any index.ts. Do NOT run bun/storybook.`;
};

const results = await parallel(
  targets.map((target) => () =>
    agent(buildPrompt(target), {
      label: `${batchName}:${target.split("/").slice(-1)[0]}`,
    }),
  ),
);

const ok = results.filter(Boolean).length;
log(`[${batchName}] agents completed=${ok}/${targets.length}`);
return { batchName, completed: ok, total: targets.length };

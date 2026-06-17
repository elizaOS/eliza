export const meta = {
  name: "add-ui-stories-rest",
  description: "Add Storybook stories using the mock-provider harness",
  phases: [{ title: "Write stories" }],
};

const targets = ["src/agent-surface/AgentElementOverlay.tsx","src/agent-surface/components.tsx","src/backgrounds/BackgroundHost.tsx","src/cloud-ui/components/auth/authorize-content.tsx","src/cloud-ui/components/docs/api-route-explorer-client.tsx","src/cloud-ui/components/docs/docs-layout.tsx","src/cloud-ui/components/docs/openapi-viewer.tsx","src/cloud-ui/components/promotion/promote-app-dialog.tsx","src/cloud-ui/components/promotion/social-connection-hint.tsx","src/companion/desktop-bar/CompanionBar.tsx","src/components/accounts/AccountList.tsx","src/components/apps/GameView.tsx","src/components/apps/GameViewOverlay.tsx","src/components/character/CharacterEditor.tsx","src/components/character/CharacterExperienceWorkspace.tsx","src/components/character/CharacterHubView.tsx","src/components/character/CharacterLearnedSkillsSection.tsx","src/components/chat/AppsSection.tsx","src/components/chat/SaveCommandModal.tsx","src/components/chat/TasksEventsPanel.tsx","src/components/chat/widgets/agent-orchestrator.tsx","src/components/chat/widgets/browser-status.tsx","src/components/chat/widgets/music-player.tsx","src/components/chat/widgets/task-widget.tsx","src/components/chat/widgets/todo.tsx","src/components/cloud/StripeEmbeddedCheckout.tsx","src/components/connectors/BlueBubblesStatusPanel.tsx","src/components/connectors/ConnectorAccountAuditList.tsx","src/components/connectors/ConnectorAccountList.tsx","src/components/connectors/ConnectorAccountSetupScope.tsx","src/components/connectors/ConnectorQrPairingOverlay.tsx","src/components/connectors/ConnectorSetupPanel.tsx","src/components/connectors/DiscordLocalConnectorPanel.tsx","src/components/connectors/IMessageStatusPanel.tsx","src/components/connectors/OwnerAgentConnectorSetupPanel.tsx","src/components/connectors/SignalQrOverlay.tsx","src/components/connectors/TelegramAccountConnectorPanel.tsx","src/components/connectors/WhatsAppQrOverlay.tsx","src/components/connectors/XRPairingPanel.tsx","src/components/conversations/ConversationRenameDialog.tsx","src/components/conversations/ConversationsSidebar.tsx","src/components/custom-actions/CustomActionsView.tsx","src/components/local-inference/LocalInferencePanel.tsx","src/components/local-inference/ModelHubView.tsx","src/components/local-inference/ProvidersList.tsx","src/components/local-inference/RoutingMatrix.tsx","src/components/shell/AssistantOverlay.tsx","src/components/shell/BugReportModal.tsx","src/components/shell/ChatSurface.tsx","src/components/shell/ComputerUseApprovalOverlay.tsx","src/components/shell/ConnectionLostOverlay.tsx","src/components/shell/FirstRunShell.tsx","src/components/shell/Header.tsx","src/components/shell/HomePill.tsx","src/components/shell/KioskViewCanvas.tsx","src/components/shell/PairingView.tsx","src/components/shell/ProvisioningChatView.tsx","src/components/shell/ShellHeaderControls.tsx","src/components/shell/ShellOverlays.tsx","src/components/shell/StartupFailureView.tsx","src/components/shell/StartupScreen.tsx","src/components/shell/StartupShell.tsx","src/components/training/BudgetPanel.tsx","src/components/training/InferenceEndpointPanel.tsx","src/components/training/JobDetailPanel.tsx","src/components/training/TrainingDashboard.tsx","src/components/training/injected.tsx","src/components/views/DynamicViewLoader.tsx","src/first-run/CompactOnboarding.tsx","src/first-run/FirstRunScreen.tsx","src/first-run/OnboardingVoicePill.tsx","src/genui/renderer.tsx","src/layouts/chat-panel-layout/chat-panel-layout.tsx","src/layouts/content-layout/content-layout.tsx","src/layouts/page-layout/page-layout-header.tsx","src/layouts/page-layout/page-layout-mobile-drawer.tsx","src/layouts/page-layout/page-layout.tsx","src/layouts/workspace-layout/workspace-layout.tsx","src/widgets/WidgetHost.tsx"];
const batchName = "rest";

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

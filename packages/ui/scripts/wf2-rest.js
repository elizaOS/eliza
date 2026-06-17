export const meta = {
  name: "add-ui-stories-v2-rest",
  description: "Add Storybook stories using the mock-provider harness (no-schema)",
  phases: [{ title: "Write stories" }],
};

const targets = ["src/cloud-ui/components/auth/authorize-content.tsx","src/components/apps/GameView.tsx","src/components/apps/GameViewOverlay.tsx","src/components/character/CharacterEditor.tsx","src/components/character/CharacterExperienceWorkspace.tsx","src/components/character/CharacterHubView.tsx","src/components/character/CharacterLearnedSkillsSection.tsx","src/components/chat/AppsSection.tsx","src/components/chat/SaveCommandModal.tsx","src/components/chat/TasksEventsPanel.tsx","src/components/chat/widgets/agent-orchestrator.tsx","src/components/chat/widgets/browser-status.tsx","src/components/chat/widgets/music-player.tsx","src/components/chat/widgets/task-widget.tsx","src/components/chat/widgets/todo.tsx","src/components/cloud/StripeEmbeddedCheckout.tsx","src/components/connectors/BlueBubblesStatusPanel.tsx","src/components/connectors/ConnectorAccountAuditList.tsx","src/components/connectors/ConnectorAccountList.tsx","src/components/connectors/ConnectorAccountSetupScope.tsx","src/components/connectors/ConnectorQrPairingOverlay.tsx","src/components/connectors/ConnectorSetupPanel.tsx","src/components/connectors/DiscordLocalConnectorPanel.tsx","src/components/connectors/IMessageStatusPanel.tsx","src/components/connectors/OwnerAgentConnectorSetupPanel.tsx","src/components/connectors/SignalQrOverlay.tsx","src/components/connectors/TelegramAccountConnectorPanel.tsx","src/components/connectors/WhatsAppQrOverlay.tsx","src/components/connectors/XRPairingPanel.tsx","src/components/conversations/ConversationRenameDialog.tsx","src/components/conversations/ConversationsSidebar.tsx","src/components/custom-actions/CustomActionsView.tsx","src/components/local-inference/LocalInferencePanel.tsx","src/components/local-inference/ModelHubView.tsx","src/components/local-inference/ProvidersList.tsx","src/components/local-inference/RoutingMatrix.tsx","src/components/shell/AssistantOverlay.tsx","src/components/shell/BugReportModal.tsx","src/components/shell/ChatSurface.tsx","src/components/shell/ComputerUseApprovalOverlay.tsx","src/components/shell/ConnectionLostOverlay.tsx","src/components/shell/FirstRunShell.tsx","src/components/shell/Header.tsx","src/components/shell/HomePill.tsx","src/components/shell/KioskViewCanvas.tsx","src/components/shell/PairingView.tsx","src/components/shell/ProvisioningChatView.tsx","src/components/shell/ShellHeaderControls.tsx","src/components/shell/ShellOverlays.tsx","src/components/shell/StartupFailureView.tsx","src/components/shell/StartupShell.tsx","src/components/training/BudgetPanel.tsx","src/components/training/InferenceEndpointPanel.tsx","src/components/training/JobDetailPanel.tsx","src/components/training/TrainingDashboard.tsx","src/components/training/injected.tsx","src/first-run/CompactOnboarding.tsx","src/first-run/FirstRunScreen.tsx","src/first-run/OnboardingVoicePill.tsx","src/genui/renderer.tsx","src/layouts/chat-panel-layout/chat-panel-layout.tsx","src/layouts/content-layout/content-layout.tsx","src/layouts/page-layout/page-layout-header.tsx","src/layouts/page-layout/page-layout-mobile-drawer.tsx","src/layouts/page-layout/page-layout.tsx","src/layouts/workspace-layout/workspace-layout.tsx","src/widgets/WidgetHost.tsx"];
const batchName = "rest";

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

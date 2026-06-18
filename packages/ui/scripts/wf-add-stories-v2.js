export const meta = {
  name: "add-ui-stories-v2",
  description: "Add Storybook stories using the mock-provider harness (no-schema)",
  phases: [{ title: "Write stories" }],
};

const targets = TARGETS_PLACEHOLDER;
const batchName = BATCHNAME_PLACEHOLDER;

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

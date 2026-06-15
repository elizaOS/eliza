import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { AppContextValue, FlaminaGuideTopic } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { DeferredSetupChecklist, FlaminaGuideCard } from "./FlaminaGuide";

const TRANSLATIONS: Record<string, string> = {
  "flaminaguide.WhenToUseLabel": "When to use:",
  "flaminaguide.IfYouSkipLabel": "If you skip:",
  "flaminaguide.CharacterImpactLabel": "Character impact:",
  "flaminaguide.FinishSetupLater": "Finish setup later",
  "flaminaguide.FinishSetupLaterDescription":
    "Pick up where you left off. These tasks are optional but recommended.",
  "common.dismiss": "Dismiss",
  "common.open": "Open",
  "common.done": "Done",
  "flaminaguide.provider.title": "Choose an AI provider",
  "flaminaguide.provider.description":
    "Pick which model powers your agent's responses.",
  "flaminaguide.provider.whenToUse":
    "Whenever you want to control quality, speed, or cost.",
  "flaminaguide.provider.skipEffect":
    "Your agent falls back to the default provider.",
  "flaminaguide.provider.characterImpact":
    "Different providers shape tone and reasoning style.",
  "flaminaguide.provider.recommended":
    "Recommended: OpenAI for balanced output.",
  "flaminaguide.rpc.title": "Set an RPC endpoint",
  "flaminaguide.rpc.description":
    "Your agent uses this RPC to read and write on-chain.",
  "flaminaguide.rpc.whenToUse": "If you plan to use crypto features.",
  "flaminaguide.rpc.skipEffect": "On-chain actions stay disabled.",
  "flaminaguide.rpc.characterImpact":
    "Lets the character act as a wallet owner.",
  "flaminaguide.rpc.recommended": "Recommended: a dedicated archive RPC.",
  "flaminaguide.tasks.provider.label": "Add a provider key",
  "flaminaguide.tasks.provider.description":
    "Plug in an API key so your agent can think.",
  "flaminaguide.tasks.rpc.label": "Configure an RPC",
  "flaminaguide.tasks.rpc.description": "Let your agent reach the chain.",
  "flaminaguide.tasks.permissions.label": "Review permissions",
  "flaminaguide.tasks.permissions.description":
    "Decide what your agent can do on your behalf.",
  "flaminaguide.tasks.voice.label": "Pick a voice",
  "flaminaguide.tasks.voice.description":
    "Choose how your character sounds when speaking.",
  "flaminaguide.tasks.features.label": "Enable features",
  "flaminaguide.tasks.features.description":
    "Turn on optional skills like memory or web search.",
};

type AppOverrides = Partial<AppContextValue>;

const makeAppContext = (overrides: AppOverrides = {}): AppContextValue =>
  new Proxy({} as AppContextValue, {
    get(_, prop) {
      if (prop in overrides) {
        return overrides[prop as keyof AppContextValue];
      }
      if (prop === "t") {
        return (key: string, opts?: { defaultValue?: string }) =>
          TRANSLATIONS[key] ?? opts?.defaultValue ?? key;
      }
      if (prop === "uiLanguage") return "en";
      if (prop === "firstRunDeferredTasks") return [];
      if (prop === "postFirstRunChecklistDismissed") return false;
      if (prop === "setState") return () => {};
      return () => {};
    },
  });

const withAppContext =
  (overrides: AppOverrides = {}) =>
  (Story: () => ReactNode) => (
    <AppContext.Provider value={makeAppContext(overrides)}>
      <div className="p-6 bg-bg max-w-2xl">
        <Story />
      </div>
    </AppContext.Provider>
  );

const meta = {
  title: "Cloud/FlaminaGuide",
  component: FlaminaGuideCard,
  tags: ["autodocs"],
  decorators: [withAppContext()],
  argTypes: {
    topic: {
      control: "select",
      options: ["provider", "rpc", "permissions", "voice", "features"],
    },
    className: { control: "text" },
  },
  args: {
    topic: "provider" satisfies FlaminaGuideTopic,
  },
} satisfies Meta<typeof FlaminaGuideCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderGuide: Story = {};

export const RpcGuide: Story = {
  args: { topic: "rpc" },
};

export const ChecklistWithTasks: Story = {
  render: () => <DeferredSetupChecklist onOpenTask={() => {}} />,
  decorators: [
    withAppContext({
      firstRunDeferredTasks: ["provider", "rpc", "voice"],
      postFirstRunChecklistDismissed: false,
    } as AppOverrides),
  ],
};

export const ChecklistEmpty: Story = {
  render: () => (
    <>
      <DeferredSetupChecklist onOpenTask={() => {}} />
      <p className="text-sm text-muted">
        (Checklist renders nothing when there are no deferred tasks.)
      </p>
    </>
  ),
  decorators: [
    withAppContext({
      firstRunDeferredTasks: [],
    } as AppOverrides),
  ],
};

export const ChecklistDismissed: Story = {
  render: () => (
    <>
      <DeferredSetupChecklist onOpenTask={() => {}} />
      <p className="text-sm text-muted">
        (Checklist renders nothing once dismissed.)
      </p>
    </>
  ),
  decorators: [
    withAppContext({
      firstRunDeferredTasks: ["provider", "rpc"],
      postFirstRunChecklistDismissed: true,
    } as AppOverrides),
  ],
};

/**
 * Storybook stories for the Settings → Models configuration panel, covering
 * the catalog loading/empty/error states and the ready panel across resting,
 * armed-restart-confirm, restarting, typed-400, and saved-coding states. Pure
 * fixture props into the presentational view — no backend, no app context.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { ModelCatalogEntry } from "../../api/client-types-core";
import { ModelConfigurationPanelView } from "./ModelConfigurationPanel";
import { SettingsStack } from "./settings-layout";
import type {
  ModelConfigChatGroup,
  ModelConfigCodingGroup,
  ModelGroupSaveState,
} from "./useModelConfiguration";

const t = (key: string, vars?: Record<string, unknown>) => {
  const template =
    typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(vars?.[name] ?? ""),
  );
};

const noop = () => {};

const CEREBRAS_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gemma-4-31b",
    display: "Gemma 4 31B",
    efforts: ["low", "medium", "high"],
    roles: ["small"],
  },
  {
    id: "zai-glm-4.7",
    display: "GLM-4.7",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
];

const CODEX_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gpt-5.6-terra",
    display: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    roles: ["coding"],
    costHint: "highest cost/latency tier",
  },
  {
    id: "gpt-5.3-codex-spark",
    display: "GPT-5.3-Codex-Spark",
    efforts: ["low", "medium", "high", "xhigh"],
    roles: ["coding"],
    apiSupported: false,
  },
];

function chatGroup(
  target: "small" | "large",
  save: ModelGroupSaveState,
): ModelConfigChatGroup {
  return {
    target,
    providerOptions: [
      { value: "cerebras", label: "Cerebras" },
      { value: "elizacloud", label: "Eliza Cloud" },
      { value: "claude-chat", label: "Claude" },
    ],
    provider: "cerebras",
    modelOptions: CEREBRAS_ENTRIES.filter((entry) =>
      entry.roles.includes(target),
    ),
    model: target === "small" ? "gemma-4-31b" : "zai-glm-4.7",
    effortOptions: ["low", "medium", "high"],
    effort: "low",
    selectedEntry:
      CEREBRAS_ENTRIES.find(
        (entry) =>
          entry.id === (target === "small" ? "gemma-4-31b" : "zai-glm-4.7"),
      ) ?? null,
    configured:
      target === "small"
        ? { model: "gemma-4-31b", source: "process.env" }
        : { model: "zai-glm-4.7", source: "config.env" },
    sharedEffortKnob: true,
    save,
    setProvider: noop,
    setModel: noop,
    setEffort: noop,
    requestSave: noop,
    confirmSave: noop,
    cancelSave: noop,
  };
}

function codingGroup(save: ModelGroupSaveState): ModelConfigCodingGroup {
  return {
    backend: "codex",
    backendOptions: [
      { value: "codex", label: "Codex" },
      { value: "claude", label: "Claude" },
      { value: "opencode", label: "OpenCode" },
      { value: "eliza-code", label: "elizaOS" },
    ],
    persistedDefaultBackend: "codex",
    makeDefault: true,
    freeFormModel: false,
    modelOptions: CODEX_ENTRIES,
    model: "gpt-5.6-terra",
    effortOptions: ["low", "medium", "high", "xhigh"],
    effort: "medium",
    selectedEntry: CODEX_ENTRIES[0] ?? null,
    configured: { model: "gpt-5.6-terra", source: "default" },
    save,
    setBackend: noop,
    setModel: noop,
    setEffort: noop,
    setMakeDefault: noop,
    saveNow: noop,
  };
}

function readyState(overrides?: {
  small?: ModelGroupSaveState;
  large?: ModelGroupSaveState;
  coding?: ModelGroupSaveState;
}) {
  return {
    phase: "ready" as const,
    small: chatGroup("small", overrides?.small ?? { phase: "idle" }),
    large: chatGroup("large", overrides?.large ?? { phase: "idle" }),
    coding: codingGroup(overrides?.coding ?? { phase: "idle" }),
  };
}

const meta = {
  title: "Settings/ModelConfigurationPanel",
  component: ModelConfigurationPanelView,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-4">
        <SettingsStack>
          <Story />
        </SettingsStack>
      </div>
    ),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof ModelConfigurationPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Catalog + config fetch in flight. */
export const Loading: Story = {
  args: { state: { phase: "loading" }, t },
};

/** Catalog fetch failed — designed error state with retry. */
export const LoadError: Story = {
  args: {
    state: {
      phase: "error",
      message: "HTTP 502 from /api/models",
      retry: noop,
    },
    t,
  },
};

/** Runtime reported no configurable models — designed empty state. */
export const EmptyCatalog: Story = {
  args: { state: { phase: "empty", retry: noop }, t },
};

/** All three groups resting, prefilled from the effective config. */
export const Ready: Story = {
  args: { state: readyState(), t },
};

/** Chat save armed: the restart warning awaits explicit confirmation. */
export const ConfirmRestart: Story = {
  args: { state: readyState({ small: { phase: "confirm" } }), t },
};

/** Chat write accepted; polling runtime status until it is back. */
export const Restarting: Story = {
  args: {
    state: readyState({
      large: { phase: "restarting", operationId: "op-42" },
    }),
    t,
  },
};

/** The route's typed 400 rendered inline with its supported values. */
export const InvalidEffort: Story = {
  args: {
    state: readyState({
      coding: {
        phase: "error",
        message:
          'Effort "ultra" is valid for gpt-5.6-terra but not parseable by the pinned codex-acp adapter',
        supported: ["low", "medium", "high", "xhigh"],
      },
    }),
    t,
  },
};

/** Coding write applied restart-free, with a service-env conflict warning. */
export const SavedCoding: Story = {
  args: {
    state: readyState({
      coding: {
        phase: "saved",
        conflictKeys: ["ELIZA_CODEX_MODEL_POWERFUL"],
      },
    }),
    t,
  },
};

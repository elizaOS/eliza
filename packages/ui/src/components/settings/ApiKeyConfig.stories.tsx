import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { ApiKeyConfig, type ApiKeyConfigProps } from "./ApiKeyConfig";

type Provider = NonNullable<ApiKeyConfigProps["selectedProvider"]>;

const openAiProvider: Provider = {
  id: "openai",
  name: "OpenAI",
  category: "ai-provider",
  enabled: true,
  configured: true,
  parameters: [
    {
      key: "OPENAI_API_KEY",
      type: "string",
      description: "Your OpenAI API key.",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: true,
    },
    {
      key: "OPENAI_BASE_URL",
      type: "string",
      description: "Override the API base URL (advanced).",
      required: false,
      sensitive: false,
      default: "https://api.openai.com/v1",
      currentValue: "https://api.openai.com/v1",
      isSet: true,
    },
  ],
};

const openRouterProvider: Provider = {
  id: "openrouter",
  name: "OpenRouter",
  category: "ai-provider",
  enabled: true,
  configured: false,
  parameters: [
    {
      key: "OPENROUTER_API_KEY",
      type: "string",
      description: "Your OpenRouter API key (starts with sk-or-).",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    },
    {
      key: "OPENROUTER_MODEL",
      type: "string",
      description: "Default model slug.",
      required: false,
      sensitive: false,
      options: ["openai/gpt-4o", "anthropic/claude-3.5-sonnet"],
      currentValue: null,
      isSet: false,
    },
  ],
};

const baseArgs: ApiKeyConfigProps = {
  selectedProvider: openAiProvider,
  pluginSaving: new Set<string>(),
  pluginSaveSuccess: new Set<string>(),
  handlePluginConfigSave: () => {},
  loadPlugins: async () => {},
};

const meta = {
  title: "Settings/ApiKeyConfig",
  component: ApiKeyConfig,
  tags: ["autodocs"],
  decorators: [withMockApp],
  args: baseArgs,
} satisfies Meta<typeof ApiKeyConfig>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {};

export const NeedsSetup: Story = {
  args: {
    selectedProvider: openRouterProvider,
  },
};

export const Saving: Story = {
  args: {
    pluginSaving: new Set<string>(["openai"]),
  },
};

export const Saved: Story = {
  args: {
    pluginSaveSuccess: new Set<string>(["openai"]),
  },
};

export const WithValidationIssues: Story = {
  args: {
    selectedProvider: {
      ...openRouterProvider,
      validationErrors: [
        {
          field: "OPENROUTER_API_KEY",
          message: "Saved key doesn't match the expected sk-or- prefix.",
        },
      ],
      validationWarnings: [
        {
          field: "OPENROUTER_MODEL",
          message: "Model slug is not in the known catalog.",
        },
      ],
    },
  },
};

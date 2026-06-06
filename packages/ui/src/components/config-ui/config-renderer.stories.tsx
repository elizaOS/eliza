import type { Meta, StoryObj } from "@storybook/react";
import type { JsonSchemaObject } from "../../config/config-catalog";
import { mockApp } from "../../storybook/mock-providers.helpers";
import type { ConfigUiHint } from "../../types";
import { ConfigRenderer } from "./config-renderer";
import { defaultRegistry } from "./config-renderer.helpers";

const schema: JsonSchemaObject = {
  type: "object",
  required: ["apiKey", "model"],
  properties: {
    apiKey: {
      type: "string",
      description: "Your provider API key.",
    },
    model: {
      type: "string",
      enum: ["gpt-4o", "claude-3-7-sonnet", "gemini-2.0-flash"],
      default: "gpt-4o",
      description: "Default text generation model.",
    },
    temperature: {
      type: "number",
      minimum: 0,
      maximum: 2,
      default: 0.7,
      description: "Sampling temperature.",
    },
    streaming: {
      type: "boolean",
      default: true,
      description: "Stream tokens as they are produced.",
    },
    systemPrompt: {
      type: "string",
      maxLength: 2000,
      description: "Optional system prompt prepended to every conversation.",
    },
    retryCount: {
      type: "integer",
      minimum: 0,
      maximum: 10,
      default: 3,
      description: "How many times to retry on failure.",
    },
  },
};

const hints: Record<string, ConfigUiHint> = {
  apiKey: { label: "API Key", group: "Auth", sensitive: true, order: 1 },
  model: { label: "Model", group: "Models", order: 1 },
  temperature: {
    label: "Temperature",
    group: "Models",
    order: 2,
    width: "half",
  },
  streaming: { label: "Stream responses", group: "Behavior", order: 1 },
  systemPrompt: { label: "System prompt", group: "Behavior", order: 2 },
  retryCount: {
    label: "Retry count",
    group: "Advanced",
    order: 1,
    advanced: true,
  },
};

const meta = {
  title: "ConfigUi/ConfigRenderer",
  component: ConfigRenderer,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [mockApp()],
  argTypes: {
    showValidationSummary: { control: "boolean" },
    pluginId: { control: "text" },
  },
  args: {
    schema,
    hints,
    registry: defaultRegistry,
    pluginId: "demo-plugin",
    values: {
      model: "gpt-4o",
      temperature: 0.7,
      streaming: true,
      retryCount: 3,
    },
    setKeys: new Set(["model", "temperature", "streaming", "retryCount"]),
    onChange: () => {},
    showValidationSummary: true,
  },
} satisfies Meta<typeof ConfigRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Standard rendering with grouped fields and an advanced section. */
export const Default: Story = {};

/** Required `apiKey` is unset — progress banner warns above the form. */
export const MissingRequired: Story = {
  args: {
    values: { model: "gpt-4o" },
    setKeys: new Set(["model"]),
  },
};

/** Some required fields filled — progress bar partially complete. */
export const PartiallyConfigured: Story = {
  args: {
    values: { apiKey: "sk-demo-1234", model: "claude-3-7-sonnet" },
    setKeys: new Set(["model"]),
  },
};

/** All required values present — no progress banner shown. */
export const FullyConfigured: Story = {
  args: {
    values: {
      apiKey: "sk-demo-1234",
      model: "claude-3-7-sonnet",
      temperature: 0.4,
      streaming: false,
      retryCount: 5,
    },
    setKeys: new Set([
      "apiKey",
      "model",
      "temperature",
      "streaming",
      "retryCount",
    ]),
  },
};

/** Empty state — no schema provided, renders a muted placeholder. */
export const NoSchema: Story = {
  args: {
    schema: null,
    values: {},
    setKeys: new Set(),
  },
};

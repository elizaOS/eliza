/**
 * Storybook states for ConfigField — the label/help/error wrapper around a field
 * renderer — across required-empty, configured, error, and help-text cases. A
 * mock `t` supplies the label/status copy.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type {
  FieldRenderer,
  FieldRenderProps,
} from "../../config/config-catalog";
import {
  type MockAppOptions,
  MockAppProvider,
} from "../../storybook/mock-providers";
import { ConfigField } from "./config-field";

const mockAppValue = {
  t: (key: string, opts?: { defaultValue?: string }) => {
    if (key === "secretsview.Required") return "Required";
    if (key === "config-field.Configured") return "Configured";
    if (key === "config-field.Times") return "×";
    return opts?.defaultValue ?? key;
  },
} satisfies MockAppOptions;

const sampleRenderer: FieldRenderer = (props: FieldRenderProps) => (
  <input
    type="text"
    value={String(props.value ?? "")}
    onChange={() => {}}
    placeholder={props.hint.placeholder}
    aria-label={props.hint.label ?? props.key}
    readOnly={props.readonly}
    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
  />
);

const baseRenderProps: FieldRenderProps = {
  key: "OPENAI_API_KEY",
  value: "",
  schema: { type: "string", description: "Your OpenAI API key." },
  hint: {
    label: "OpenAI API Key",
    help: "Used to authenticate with the OpenAI API.",
    placeholder: "sk-...",
  },
  fieldType: "text",
  onChange: () => {},
  isSet: false,
  required: false,
  errors: [],
  readonly: false,
};

const meta = {
  title: "ConfigUi/ConfigField",
  component: ConfigField,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider value={mockAppValue}>
        <div className="p-6 max-w-md bg-background">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  argTypes: {
    pluginId: { control: "text" },
  },
  args: {
    renderProps: baseRenderProps,
    renderer: sampleRenderer,
    pluginId: "openai",
  },
} satisfies Meta<typeof ConfigField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Configured: Story = {
  args: {
    renderProps: {
      ...baseRenderProps,
      value: "sk-************************",
      isSet: true,
    },
  },
};

export const RequiredEmpty: Story = {
  args: {
    renderProps: {
      ...baseRenderProps,
      required: true,
      isSet: false,
    },
  },
};

export const WithErrors: Story = {
  args: {
    renderProps: {
      ...baseRenderProps,
      value: "invalid-key",
      errors: [
        "API key must start with sk-",
        "API key length is below the expected minimum",
      ],
    },
  },
};

export const Readonly: Story = {
  args: {
    renderProps: {
      ...baseRenderProps,
      value: "sk-readonly-value",
      isSet: true,
      readonly: true,
    },
  },
};

export const WithDefault: Story = {
  args: {
    renderProps: {
      ...baseRenderProps,
      key: "OPENAI_MODEL",
      hint: { label: "Model", help: "Which OpenAI chat model to use." },
      schema: {
        type: "string",
        description: "Which OpenAI chat model to use.",
        default: "gpt-4o-mini",
      },
    },
  },
};

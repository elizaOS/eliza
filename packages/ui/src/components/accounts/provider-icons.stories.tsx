/** Provider identity marks rendered in their neutral, inherited-color treatment. */
import type { Meta, StoryObj } from "@storybook/react";
import {
  AnthropicMark,
  ApiKeyMark,
  CerebrasMark,
  DeepSeekMark,
  ElizaCloudMark,
  GeminiMark,
  LocalMark,
  MoonshotMark,
  OpenAIMark,
  ZaiMark,
} from "./provider-icons";

const marks = [
  ["Anthropic", AnthropicMark],
  ["OpenAI", OpenAIMark],
  ["Gemini", GeminiMark],
  ["DeepSeek", DeepSeekMark],
  ["Moonshot", MoonshotMark],
  ["Z.ai", ZaiMark],
  ["Cerebras", CerebrasMark],
  ["External API key", ApiKeyMark],
  ["Eliza Cloud", ElizaCloudMark],
  ["Local", LocalMark],
] as const;

const meta = {
  title: "Accounts/ProviderIcons",
  component: OpenAIMark,
  parameters: { layout: "centered" },
} satisfies Meta<typeof OpenAIMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Catalog: Story = {
  render: () => (
    <div className="grid grid-cols-3 gap-6">
      {marks.map(([label, Mark]) => (
        <div key={label} className="flex flex-col items-center gap-2 text-txt">
          <Mark className="h-8 w-8" title={label} />
          <span className="text-xs text-muted">{label}</span>
        </div>
      ))}
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/react";
import { TrajectoryLlmCallCard } from "./trajectory-llm-call-card";

const SAMPLE_USER_PROMPT = `Summarize the user's morning routine and suggest one\nadjustment that could save 15 minutes.`;

const SAMPLE_RESPONSE = `The user wakes at 6:45am, journals, then makes pour-over coffee.\n\nSuggestion: pre-grind beans the night before to cut 12-15 minutes from the morning.`;

const SAMPLE_SYSTEM_PROMPT = `You are a productivity coach.\nBe concise and direct.\nNever invent facts the user did not provide.`;

const meta = {
  title: "Composites/Trajectories/TrajectoryLlmCallCard",
  component: TrajectoryLlmCallCard,
  tags: ["autodocs"],
  argTypes: {
    model: { control: "text" },
    response: { control: "text" },
    userPrompt: { control: "text" },
    systemPrompt: { control: "text" },
    tags: { control: "object" },
  },
  args: {
    callLabel: "LLM Call",
    copyLabel: "Copy",
    copyToClipboardLabel: "Copy to clipboard",
    inputLabel: "Input",
    latencyLabel: "Latency",
    latencyValue: "842 ms",
    maxLabel: "Max tokens",
    maxValue: "2,048",
    model: "claude-opus-4-7",
    onCopy: () => {},
    outputLabel: "Output",
    purposeLabel: "Purpose",
    response: SAMPLE_RESPONSE,
    systemCollapseLabel: "Hide system prompt",
    systemExpandLabel: "Show system prompt",
    systemLabel: "System",
    systemLinesLabel: "3 lines",
    systemPromptButtonLabel: "System prompt",
    temperatureLabel: "Temperature",
    temperatureValue: "0.7",
    tokensLabel: "Tokens",
    totalTokensValue: "1,284",
    tokenBreakdownMeta: "612 in / 672 out",
    tags: ["routine", "summary"],
    inputLinesLabel: "2 lines",
    outputLinesLabel: "3 lines",
    userPrompt: SAMPLE_USER_PROMPT,
  },
} satisfies Meta<typeof TrajectoryLlmCallCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithSystemPrompt: Story = {
  args: {
    systemPrompt: SAMPLE_SYSTEM_PROMPT,
  },
};

export const NoTags: Story = {
  args: {
    tags: undefined,
  },
};

export const LongResponse: Story = {
  args: {
    model: "gpt-4o",
    tags: ["planning", "long-form"],
    totalTokensValue: "4,902",
    tokenBreakdownMeta: "1,204 in / 3,698 out",
    latencyValue: "3.1 s",
    outputLinesLabel: "24 lines",
    response: Array.from(
      { length: 12 },
      (_, i) => `Step ${i + 1}: think carefully about the next move.`,
    ).join("\n"),
  },
};

export const SmallModel: Story = {
  args: {
    model: "llama-3.2-3b (local)",
    tags: ["on-device"],
    temperatureValue: "0.2",
    maxValue: "512",
    totalTokensValue: "184",
    tokenBreakdownMeta: "96 in / 88 out",
    latencyValue: "118 ms",
    systemPrompt: SAMPLE_SYSTEM_PROMPT,
  },
};

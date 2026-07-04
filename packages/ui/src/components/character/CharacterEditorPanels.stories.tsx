/** Storybook stories for the character editor's identity/style/examples panels. */
import type { Meta, StoryObj } from "@storybook/react";
import type { CharacterData } from "../../api/client-types-config";
import {
  CharacterExamplesPanel,
  CharacterIdentityPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";

const noop = () => {};
const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? "";

const meta = {
  title: "Character/CharacterEditorPanels",
  component: CharacterIdentityPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-3xl bg-bg p-6 text-txt">
        <Story />
      </div>
    ),
  ],
  args: {
    bioText:
      "I'm a thoughtful assistant who helps with research, scheduling, and bringing structure to messy projects.",
    handleFieldEdit: noop,
    t,
  },
} satisfies Meta<typeof CharacterIdentityPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Identity: Story = {};

export const IdentityEmpty: Story = {
  args: {
    bioText: "",
  },
};

const sampleCharacter: CharacterData = {
  name: "Aria",
  style: {
    all: [
      "Speak clearly and concisely.",
      "Prefer concrete examples over abstract ones.",
      "Acknowledge uncertainty honestly.",
    ],
    chat: [],
    post: [],
  },
  messageExamples: [
    {
      examples: [
        { name: "{{user1}}", content: { text: "What's on the agenda today?" } },
        {
          name: "Aria",
          content: {
            text: "Two design reviews and the quarterly sync at 3pm.",
          },
        },
      ],
    },
  ],
  postExamples: [
    "Shipped a quiet refactor today. Less code, fewer surprises.",
    "Reminder: the best estimate is the one you can defend.",
  ],
};

export const StyleRulesPopulated: Story = {
  render: () => (
    <CharacterStylePanel
      d={sampleCharacter}
      pendingStyleEntries={{ all: "" }}
      styleEntryDrafts={{ all: sampleCharacter.style?.all ?? [] }}
      handlePendingStyleEntryChange={noop}
      handleAddStyleEntry={noop}
      handleRemoveStyleEntry={noop}
      handleStyleEntryDraftChange={noop}
      handleCommitStyleEntry={noop}
      handleReorderStyleEntries={noop}
      t={t}
    />
  ),
};

export const StyleRulesEmpty: Story = {
  render: () => (
    <CharacterStylePanel
      d={{ ...sampleCharacter, style: { all: [] } }}
      pendingStyleEntries={{ all: "" }}
      styleEntryDrafts={{ all: [] }}
      handlePendingStyleEntryChange={noop}
      handleAddStyleEntry={noop}
      handleRemoveStyleEntry={noop}
      handleStyleEntryDraftChange={noop}
      handleCommitStyleEntry={noop}
      handleReorderStyleEntries={noop}
      t={t}
    />
  ),
};

export const ExamplesPopulated: Story = {
  render: () => (
    <CharacterExamplesPanel
      d={sampleCharacter}
      normalizedMessageExamples={sampleCharacter.messageExamples ?? []}
      handleFieldEdit={noop}
      t={t}
    />
  ),
};

export const ExamplesEmpty: Story = {
  render: () => (
    <CharacterExamplesPanel
      d={{ name: "Aria", postExamples: [], messageExamples: [] }}
      normalizedMessageExamples={[]}
      handleFieldEdit={noop}
      t={t}
    />
  ),
};

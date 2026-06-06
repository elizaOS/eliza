import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { CharacterRoster, type CharacterRosterEntry } from "./CharacterRoster";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    return () => {};
  },
});

function makeEntry(
  id: string,
  name: string,
  avatarIndex: number,
  extra: Partial<CharacterRosterEntry> = {},
): CharacterRosterEntry {
  return {
    id,
    name,
    avatarIndex,
    catchphrase: extra.catchphrase,
    previewUrl:
      extra.previewUrl ??
      `https://placehold.co/280x300/0b0f14/f0b90b?text=${encodeURIComponent(name)}`,
    voicePresetId: extra.voicePresetId,
    greetingAnimation: extra.greetingAnimation,
    preset: {
      id,
      name,
      avatarIndex,
      voicePresetId: extra.voicePresetId ?? "",
      greetingAnimation: extra.greetingAnimation ?? "",
      catchphrase: extra.catchphrase ?? "",
      hint: "",
      bio: [],
      system: "",
      adjectives: [],
      style: { all: [], chat: [], post: [] },
      topics: [],
      postExamples: [],
      messageExamples: [],
    },
  };
}

const sampleEntries: CharacterRosterEntry[] = [
  makeEntry("nova", "Nova", 1, { catchphrase: "Always one step ahead." }),
  makeEntry("rune", "Rune", 2, { catchphrase: "Patterns in everything." }),
  makeEntry("orion", "Orion", 3, { catchphrase: "Steady as a star." }),
  makeEntry("vex", "Vex", 4, { catchphrase: "Move fast, fix later." }),
  makeEntry("lyra", "Lyra", 5, { catchphrase: "Music in the data." }),
];

function InteractiveRoster(props: {
  entries: CharacterRosterEntry[];
  variant?: "first-run" | "editor";
  initialSelectedId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    props.initialSelectedId ?? null,
  );
  return (
    <CharacterRoster
      entries={props.entries}
      selectedId={selectedId}
      onSelect={(entry) => setSelectedId(entry.id)}
      variant={props.variant}
    />
  );
}

const meta = {
  title: "Character/CharacterRoster",
  component: CharacterRoster,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="bg-background flex min-h-[360px] w-full items-center justify-center p-8">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  argTypes: {
    variant: { control: "radio", options: ["editor", "first-run"] },
    selectedId: { control: "text" },
  },
  args: {
    entries: sampleEntries,
    selectedId: "rune",
    onSelect: () => {},
    variant: "editor",
    testIdPrefix: "character",
  },
} satisfies Meta<typeof CharacterRoster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FirstRunVariant: Story = {
  args: {
    variant: "first-run",
    selectedId: "nova",
  },
};

export const NoSelection: Story = {
  args: {
    selectedId: null,
  },
};

export const Empty: Story = {
  args: {
    entries: [],
    selectedId: null,
  },
};

export const Interactive: Story = {
  render: (args) => (
    <InteractiveRoster
      entries={args.entries}
      variant={args.variant}
      initialSelectedId={args.selectedId}
    />
  ),
  args: {
    selectedId: "orion",
  },
};

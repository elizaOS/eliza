/** Storybook stories for the character hub's overview grid (full + empty states). */
import type { Meta, StoryObj } from "@storybook/react";
import {
  CharacterOverviewSection,
  type CharacterOverviewWidget,
} from "./CharacterOverviewSection";

const noopOpen = (_section: string) => {};

const fullWidgets: CharacterOverviewWidget[] = [
  {
    section: "personality",
    title: "Personality",
    isEmpty: false,
    body: (
      <div className="flex flex-wrap gap-1.5">
        {["warm", "curious", "playful", "direct"].map((t) => (
          <span
            key={t}
            className="rounded-full border border-border/40 bg-bg/60 px-2 py-0.5 text-2xs text-txt"
          >
            {t}
          </span>
        ))}
      </div>
    ),
  },
  {
    section: "relationships",
    title: "Relationships",
    isEmpty: false,
    body: (
      <div className="flex -space-x-2">
        {[1, 2, 3, 4].map((i) => (
          <img
            key={i}
            src={`https://placehold.co/40x40/orange/white?text=${i}`}
            alt=""
            className="h-8 w-8 rounded-full border border-border/40"
          />
        ))}
      </div>
    ),
  },
  {
    section: "documents",
    title: "Documents",
    isEmpty: false,
  },
  {
    section: "skills",
    title: "Skills",
    isEmpty: false,
  },
  {
    section: "experience",
    title: "Experience",
    isEmpty: false,
  },
];

const emptyWidgets: CharacterOverviewWidget[] = [
  { section: "personality", title: "Personality", isEmpty: true },
  {
    section: "relationships",
    title: "Relationships",
    isEmpty: true,
  },
  { section: "documents", title: "Documents", isEmpty: true },
  { section: "skills", title: "Skills", isEmpty: true },
  { section: "experience", title: "Experience", isEmpty: true },
];

const loadingWidgets: CharacterOverviewWidget[] = fullWidgets.map((w) => ({
  ...w,
  isLoading: true,
  body: null,
}));

const meta = {
  title: "Character/CharacterOverviewSection",
  component: CharacterOverviewSection,
  tags: ["autodocs"],
  argTypes: {
    onOpenSection: { action: "open-section" },
    characterName: { control: "text" },
  },
  args: {
    onOpenSection: noopOpen,
    characterName: "Eliza",
    widgets: fullWidgets,
  },
  decorators: [
    (Story) => (
      <div className="min-h-[520px] w-full max-w-5xl bg-bg p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CharacterOverviewSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    widgets: emptyWidgets,
  },
};

export const Loading: Story = {
  args: {
    widgets: loadingWidgets,
  },
};

export const PartiallyPopulated: Story = {
  args: {
    widgets: [
      fullWidgets[0],
      { ...fullWidgets[1], body: null, isEmpty: true },
      fullWidgets[2],
      { ...fullWidgets[3], body: null, isEmpty: true },
      fullWidgets[4],
    ],
  },
};

export const SubsetOfSections: Story = {
  args: {
    widgets: [fullWidgets[0], fullWidgets[3]],
  },
};

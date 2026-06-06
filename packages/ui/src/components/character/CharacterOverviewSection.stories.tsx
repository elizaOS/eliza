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
    meta: "8 traits",
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
    meta: "12 people",
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
    meta: "3 docs",
    isEmpty: false,
  },
  {
    section: "skills",
    title: "Skills",
    meta: "12 skills",
    isEmpty: false,
  },
  {
    section: "experience",
    title: "Experience",
    meta: "47 memories",
    isEmpty: false,
  },
];

const emptyWidgets: CharacterOverviewWidget[] = [
  { section: "personality", title: "Personality", meta: null, isEmpty: true },
  {
    section: "relationships",
    title: "Relationships",
    meta: null,
    isEmpty: true,
  },
  { section: "documents", title: "Documents", meta: null, isEmpty: true },
  { section: "skills", title: "Skills", meta: null, isEmpty: true },
  { section: "experience", title: "Experience", meta: null, isEmpty: true },
];

const loadingWidgets: CharacterOverviewWidget[] = fullWidgets.map((w) => ({
  ...w,
  isLoading: true,
  meta: null,
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
      { ...fullWidgets[1], meta: null, body: null, isEmpty: true },
      fullWidgets[2],
      { ...fullWidgets[3], meta: null, body: null, isEmpty: true },
      fullWidgets[4],
    ],
  },
};

export const SubsetOfSections: Story = {
  args: {
    widgets: [fullWidgets[0], fullWidgets[3]],
  },
};

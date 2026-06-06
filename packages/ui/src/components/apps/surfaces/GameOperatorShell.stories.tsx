import type { Meta, StoryObj } from "@storybook/react";
import {
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
} from "./GameOperatorShell";

const now = Date.now();

const primaryActions: GameOperatorAction[] = [
  { id: "look", label: "Look around", command: "look" },
  { id: "inventory", label: "Inventory", command: "inventory" },
  { id: "rest", label: "Rest", command: "rest", active: true },
  { id: "map", label: "Open map", command: "map" },
];

const suggestedActions: GameOperatorAction[] = [
  { id: "talk", label: "Talk to guard", command: "talk guard" },
  { id: "search", label: "Search chest", command: "search chest" },
  { id: "leave", label: "Leave room", command: "leave" },
];

const events: GameOperatorEvent[] = [
  {
    id: "e1",
    label: "Narrator",
    message:
      "You step into a dim hallway lined with flickering torches. A draft pulls at your cloak.",
    tone: "info",
    timestamp: now - 1000 * 60 * 5,
  },
  {
    id: "e2",
    label: "You",
    message: "look around",
    tone: "user",
    timestamp: now - 1000 * 60 * 4,
  },
  {
    id: "e3",
    label: "Narrator",
    message:
      "A locked chest sits against the far wall. The guard eyes you warily.",
    tone: "info",
    timestamp: now - 1000 * 60 * 3,
  },
  {
    id: "e4",
    label: "System",
    message: "You found a brass key (+1).",
    tone: "success",
    timestamp: now - 1000 * 60 * 2,
  },
];

const meta = {
  title: "Apps/Surfaces/GameOperatorShell",
  component: GameOperatorShell,
  tags: ["autodocs"],
  argTypes: {
    statusTone: { control: "select", options: ["live", "attention", "idle"] },
    variant: { control: "select", options: ["detail", "live", "running"] },
    canSend: { control: "boolean" },
    sending: { control: "boolean" },
  },
  args: {
    surfaceTestId: "game-operator-shell",
    title: "Castle of Echoes",
    statusLabel: "Live",
    statusTone: "live",
    objective:
      "Find the missing heir before nightfall and return to the merchants' guild.",
    detailItems: [
      { label: "Location", value: "East Hallway" },
      { label: "HP", value: "18/20" },
      { label: "Turn", value: "14" },
    ],
    primaryActions,
    suggestedActions,
    events,
    emptyEventsLabel: "No events yet — type a command to begin.",
    canSend: true,
    sending: false,
    noticeTestId: "game-operator-notice",
    variant: "detail",
    onCommand: () => {},
  },
} satisfies Meta<typeof GameOperatorShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    statusLabel: "Idle",
    statusTone: "idle",
    objective: null,
    detailItems: [],
    events: [],
    suggestedActions: [],
    emptyEventsLabel: "Awaiting your first command…",
  },
};

export const Sending: Story = {
  args: {
    statusLabel: "Sending",
    statusTone: "attention",
    sending: true,
  },
};

export const ErrorTone: Story = {
  args: {
    statusLabel: "Attention",
    statusTone: "attention",
    events: [
      ...events,
      {
        id: "e5",
        label: "System",
        message: "The guard draws his sword! Combat begins.",
        tone: "warning",
        timestamp: now - 1000 * 30,
      },
      {
        id: "e6",
        label: "System",
        message: "You take 4 damage.",
        tone: "error",
        timestamp: now - 1000 * 10,
      },
    ],
  },
};

export const LiveVariant: Story = {
  args: {
    variant: "live",
  },
};

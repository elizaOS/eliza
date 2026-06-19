/** Conversational intake form for tarot readings. */

import type { FormControlOption, FormDefinition } from "../types";

const SPREAD_OPTIONS: FormControlOption[] = [
  {
    value: "three_card",
    label: "Three-Card Spread",
    description: "Past, Present, Future — quick and focused",
  },
  {
    value: "celtic_cross",
    label: "Celtic Cross",
    description: "The classic 10-card deep dive into your situation",
  },
  {
    value: "horseshoe",
    label: "Horseshoe Spread",
    description: "7 cards covering past influences through final outcome",
  },
  {
    value: "single_card",
    label: "Single Card",
    description: "One card, one message — perfect for daily guidance",
  },
  {
    value: "relationship",
    label: "Relationship Spread",
    description: "Explores the dynamics between you and another person",
  },
];

export const tarotIntakeForm: FormDefinition = {
  id: "tarot_intake",
  name: "Tarot Reading Intake",
  description:
    "Let's prepare your tarot reading. I'll need to know what's on your mind " +
    "and how deep you'd like to go.",
  controls: [
    {
      key: "question",
      type: "text",
      label: "Your Question",
      required: true,
      ask:
        "What question or area of your life would you like guidance on? " +
        "It can be specific ('Should I take that new job?') or open " +
        "('What do I need to know right now?').",
      description: "The querent's question or focus area for the reading",
      hint: ["question", "focus", "guidance", "about", "wondering", "curious"],
      example: "What should I focus on in my career this month?",
      minLength: 5,
      maxLength: 500,
    },
    {
      key: "spread",
      type: "select",
      label: "Spread Type",
      required: true,
      ask:
        "Which spread would you like?\n" +
        "- **Three-Card** — quick Past/Present/Future snapshot\n" +
        "- **Celtic Cross** — the classic deep dive (10 cards)\n" +
        "- **Horseshoe** — 7 cards from past to outcome\n" +
        "- **Single Card** — one focused message\n" +
        "- **Relationship** — dynamics between you and another\n\n" +
        "If you're not sure, the Three-Card is a great place to start.",
      description: "The tarot spread to use for the reading",
      default: "three_card",
      hint: ["spread", "cards", "celtic", "three card", "single", "horseshoe", "relationship"],
      options: SPREAD_OPTIONS,
    },
    {
      key: "allow_reversals",
      type: "boolean",
      label: "Include Reversed Cards",
      ask:
        "Would you like to include reversed (upside-down) cards? " +
        "Reversals add nuance and depth but can feel more intense. " +
        "Most readers recommend including them.",
      description: "Whether reversed card orientations are included in the reading",
      default: true,
      hint: ["reversed", "reversal", "upside down", "inverted"],
    },
  ],
  onSubmit: "handle_tarot_intake",
  onCancel: "handle_reading_cancel",
  ttl: { minDays: 1, maxDays: 7 },
  nudgeAfterMinutes: 24,
  nudgeMessage:
    "I noticed you started setting up a tarot reading but didn't finish. " +
    "Would you like to pick up where you left off, or start fresh?",
};

export default tarotIntakeForm;

/** Post-reading feedback form. */

import type { FormControlOption, FormDefinition } from "../types";

const SATISFACTION_OPTIONS: FormControlOption[] = [
  { value: "5", label: "Deeply meaningful", description: "This reading really spoke to me" },
  { value: "4", label: "Very helpful", description: "I gained useful insights" },
  { value: "3", label: "Somewhat helpful", description: "Some parts resonated, others didn't" },
  { value: "2", label: "Not very helpful", description: "It didn't quite connect for me" },
  { value: "1", label: "Not helpful at all", description: "I didn't find it meaningful" },
];

/**
 * Designed to be light and conversational — only satisfaction is required.
 * Everything else is collected naturally through conversation.
 */
export const readingFeedbackForm: FormDefinition = {
  id: "reading_feedback",
  name: "Reading Feedback",
  description:
    "Thank you for sharing this journey with me. I'd love to hear how " +
    "the reading landed for you — your feedback helps me give better " +
    "readings in the future.",
  controls: [
    {
      key: "satisfaction",
      type: "select",
      label: "Overall Experience",
      required: true,
      ask:
        "How would you describe your overall experience with this reading?\n" +
        "- **Deeply meaningful** — really spoke to me\n" +
        "- **Very helpful** — gained useful insights\n" +
        "- **Somewhat helpful** — some parts resonated\n" +
        "- **Not very helpful** — didn't quite connect\n" +
        "- **Not helpful at all** — didn't find it meaningful",
      description: "Overall satisfaction rating from 1 (low) to 5 (high)",
      hint: [
        "rating",
        "satisfaction",
        "experience",
        "how was",
        "meaningful",
        "helpful",
        "not helpful",
      ],
      options: SATISFACTION_OPTIONS,
    },
    {
      key: "resonant_insight",
      type: "text",
      label: "Most Resonant Insight",
      ask:
        "Was there a particular moment or insight from the reading that " +
        "stood out to you? Even a small detail that stuck with you.",
      description: "The insight or moment from the reading that resonated most",
      hint: [
        "stood out",
        "resonated",
        "insight",
        "moment",
        "favorite",
        "meaningful",
        "remember",
        "stuck",
      ],
      example: "When The Star card came up in the outcome position, it gave me hope",
      maxLength: 1000,
    },
    {
      key: "suggestions",
      type: "text",
      label: "Suggestions",
      ask:
        "Is there anything you wish had been different about the reading? " +
        "Any way I could have made it more meaningful for you?",
      description: "Suggestions for improving future readings",
      hint: [
        "suggest",
        "improve",
        "better",
        "different",
        "wish",
        "change",
        "feedback",
        "could have",
      ],
      maxLength: 1000,
    },
    {
      key: "wants_another",
      type: "boolean",
      label: "Interested in Another Reading",
      ask:
        "Would you be interested in doing another reading in the future? " +
        "No pressure at all — just curious.",
      description: "Whether the user is interested in future readings",
      hint: ["another", "again", "next time", "future", "more readings"],
      default: false,
    },
  ],
  onSubmit: "handle_reading_feedback",
  ttl: { minDays: 3, maxDays: 14 },
};

export default readingFeedbackForm;

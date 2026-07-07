/** Storybook + story-gate visual states for the inline chat FormRequest widget. */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import type { FormRequestSpec } from "../message-form-parser";
import { FormRequest } from "./form-request";

const meta = {
  title: "Chat/Widgets/FormRequest",
  component: FormRequest,
  tags: ["autodocs"],
  argTypes: {
    onSubmit: { action: "submit" },
  },
  decorators: [mockApp()],
} satisfies Meta<typeof FormRequest>;

export default meta;
type Story = StoryObj<typeof meta>;

const contactForm: FormRequestSpec = {
  id: "contact-form",
  title: "Contact details",
  description: "We'll only use this to follow up on your booking.",
  submitLabel: "Send",
  fields: [
    {
      name: "fullName",
      type: "text",
      label: "Full name",
      placeholder: "Ada Lovelace",
      required: true,
    },
    {
      name: "email",
      type: "text",
      label: "Email",
      placeholder: "you@example.com",
      required: true,
    },
    {
      name: "guests",
      type: "number",
      label: "Number of guests",
      placeholder: "2",
    },
    {
      name: "seating",
      type: "select",
      label: "Seating preference",
      placeholder: "Pick one",
      required: true,
      options: [
        { label: "Indoor", value: "indoor" },
        { label: "Patio", value: "patio" },
        { label: "Bar", value: "bar" },
      ],
    },
    {
      name: "newsletter",
      type: "checkbox",
      label: "Email me weekly specials",
    },
  ],
};

export const Default: Story = {
  args: {
    form: contactForm,
    onSubmit: () => {},
  },
};

export const TitleOnly: Story = {
  args: {
    form: {
      id: "feedback",
      title: "Quick feedback",
      submitLabel: "Submit",
      fields: [
        {
          name: "comment",
          type: "text",
          label: "What could be better?",
          placeholder: "Type your thoughts...",
        },
      ],
    },
    onSubmit: () => {},
  },
};

export const RequiredFieldsOnly: Story = {
  args: {
    form: {
      id: "signup",
      title: "Sign up",
      description: "All fields required.",
      submitLabel: "Create account",
      fields: [
        {
          name: "username",
          type: "text",
          label: "Username",
          required: true,
        },
        {
          name: "password",
          type: "text",
          label: "Password",
          required: true,
        },
        {
          name: "tos",
          type: "checkbox",
          label: "I agree to the terms of service",
        },
      ],
    },
    onSubmit: () => {},
  },
};

export const SelectAndCheckboxOnly: Story = {
  args: {
    form: {
      id: "preferences",
      title: "Preferences",
      submitLabel: "Save",
      fields: [
        {
          name: "theme",
          type: "select",
          label: "Theme",
          placeholder: "System default",
          options: [
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
            { label: "High contrast", value: "high-contrast" },
          ],
        },
        {
          name: "notifications",
          type: "checkbox",
          label: "Enable desktop notifications",
        },
        {
          name: "telemetry",
          type: "checkbox",
          label: "Share anonymous usage data",
        },
      ],
    },
    onSubmit: () => {},
  },
};

export const SchedulingWithTemporalFields: Story = {
  args: {
    form: {
      id: "schedule-reminder",
      title: "Schedule reminder",
      description: "Native date/time/datetime pickers (#14323).",
      submitLabel: "Create",
      fields: [
        {
          name: "title",
          type: "text",
          label: "Reminder",
          placeholder: "Call the pharmacy",
          required: true,
        },
        { name: "day", type: "date", label: "Day", required: true },
        { name: "at", type: "time", label: "Time" },
        { name: "when", type: "datetime", label: "Exact date + time" },
        {
          name: "channel",
          type: "select",
          label: "Notify via",
          placeholder: "Pick one",
          options: [
            { label: "Push", value: "push" },
            { label: "Email", value: "email" },
          ],
        },
      ],
    },
    onSubmit: () => {},
  },
};

export const Minimal: Story = {
  args: {
    form: {
      id: "minimal",
      submitLabel: "OK",
      fields: [
        {
          name: "answer",
          type: "text",
          placeholder: "Type something",
        },
      ],
    },
    onSubmit: () => {},
  },
};

export const SubmittedCollapsed: Story = {
  args: {
    form: {
      id: "minimal-submitted",
      title: "Quick answer",
      submitLabel: "OK",
      fields: [
        {
          name: "answer",
          type: "text",
          placeholder: "Type something",
        },
      ],
    },
    onSubmit: () => {},
  },
  play: async ({ canvasElement }) => {
    const submit = canvasElement.querySelector("button[type='submit']");
    assert(submit instanceof HTMLButtonElement, "submit button is visible");
    submit.click();
    const summary = await waitForTestId(
      canvasElement,
      "form-request-shell-summary",
    );
    assert(
      /quick answer submitted/i.test(summary.textContent ?? ""),
      "submitted form summary is visible",
    );
  },
};

/** #14323 — scheduling form with native date/time/datetime pickers. */
const reminderForm: FormRequestSpec = {
  id: "reminder-form",
  title: "Set your reminder",
  description: "Pick when you want to be nudged.",
  submitLabel: "Create reminder",
  fields: [
    {
      name: "title",
      type: "text",
      label: "Reminder",
      placeholder: "Take meds",
      required: true,
    },
    { name: "day", type: "date", label: "Day", required: true },
    { name: "at", type: "time", label: "At", required: true },
    { name: "until", type: "datetime", label: "Repeat until (optional)" },
  ],
};

export const SchedulingPickers: Story = {
  args: {
    form: reminderForm,
    onSubmit: () => {},
  },
};

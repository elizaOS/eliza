/** Storybook + story-gate visual states for the inline chat FormRequest widget. */
import type { Meta, StoryObj } from "@storybook/react";
import type { FormRequestSpec } from "../message-form-parser";
import { FormRequest } from "./form-request";

const meta = {
  title: "Chat/Widgets/FormRequest",
  component: FormRequest,
  tags: ["autodocs"],
  argTypes: {
    onSubmit: { action: "submit" },
  },
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

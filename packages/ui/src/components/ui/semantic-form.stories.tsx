/** Storybook fixtures exercising native form submission and disabled-field states through SemanticForm. */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { userEvent } from "storybook/test";
import { assert } from "../../storybook/home-widget-decorator";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { SemanticForm } from "./semantic-form";

function FormExample({ disabled = false }: { disabled?: boolean }) {
  const [submittedName, setSubmittedName] = useState<string>();

  return (
    <SemanticForm
      className="flex w-80 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("agent-name");
        setSubmittedName(typeof value === "string" ? value : "");
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="semantic-form-agent-name">Agent name</Label>
        <Input
          defaultValue="Ada"
          disabled={disabled}
          id="semantic-form-agent-name"
          name="agent-name"
          required
        />
      </div>
      <Button className="self-start" disabled={disabled} type="submit">
        Save agent
      </Button>
      <p aria-live="polite" className="text-sm text-muted" role="status">
        {submittedName === undefined
          ? "No submission yet."
          : `Saved ${submittedName}.`}
      </p>
    </SemanticForm>
  );
}

const meta = {
  title: "Primitives/SemanticForm",
  component: SemanticForm,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof SemanticForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Submission: Story = {
  render: () => <FormExample />,
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector("#semantic-form-agent-name");
    assert(input instanceof HTMLInputElement, "agent name input renders");
    await userEvent.clear(input);
    await userEvent.type(input, "Mira");

    const submit = canvasElement.querySelector('button[type="submit"]');
    assert(submit instanceof HTMLButtonElement, "submit button renders");
    await userEvent.click(submit);

    const status = canvasElement.querySelector('[role="status"]');
    assert(status instanceof HTMLElement, "submission status renders");
    assert(status.textContent === "Saved Mira.", "submitted value is reported");
  },
};

export const Disabled: Story = {
  render: () => <FormExample disabled />,
};

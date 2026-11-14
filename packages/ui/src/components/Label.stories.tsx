import { expect, fn, userEvent, within } from "storybook/test";
import { Checkbox } from "./Checkbox.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

export default { title: "Ui/Label", component: Label };

const checked = fn();

/** A label names the control it wraps, which no value of `children` derived from its type shows. */
export const Default = {
  args: { children: <><Checkbox onCheckedChange={checked} />Gift wrap</> },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    checked.mockClear();
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole("checkbox", { name: "Gift wrap" });
    await userEvent.click(canvas.getByText("Gift wrap"));
    await expect(checkbox.getAttribute("aria-checked")).toBe("true");
    checkbox.focus();
    await userEvent.keyboard(" ");
    await expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await expect(checked.mock.calls).toEqual([[true], [false]]);
  },
};

export const WithInput = {
  args: { htmlFor: "quantity", children: <>Quantity<Input id="quantity" /></> },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Quantity"));
    await userEvent.keyboard("12");
    await expect(canvas.getByRole<HTMLInputElement>("textbox", { name: "Quantity" }).value).toBe("12");
  },
};

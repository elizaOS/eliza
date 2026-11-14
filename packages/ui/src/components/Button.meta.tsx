import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ButtonProps } from "./Button.tsx";

const link = () => {
  const onClick = fn();
  return { asChild: true, onClick, children: <a href="#orders" onClick={onClick}>Orders</a> };
};
const disabledLink = link();
const loadingLink = link();

const refusesChild = async (anchor: HTMLElement, onClick: ReturnType<typeof fn>) => {
  await userEvent.click(anchor, { pointerEventsCheck: 0 });
  anchor.focus();
  await userEvent.keyboard("{Enter} ");
  await expect(onClick).not.toHaveBeenCalled();
};

export const meta: ComponentMeta<ButtonProps> = {
  examples: {
    // `asChild` needs an element to become, which no type can supply.
    AsChild: link(),
    "Disabled link": { ...disabledLink, disabled: true },
    "Loading link": { ...loadingLink, loading: true },
    // A button without text is named by `aria-label`.
    Empty: { size: "icon", "aria-label": "Add", children: undefined },
  },
  // The generated play of a disabled or loading story checks that it refuses clicks and keys; these check what a person is told.
  play: {
    AsChild: async ({ args, canvasElement }: { args: ButtonProps; canvasElement: HTMLElement }) => {
      await userEvent.click(within(canvasElement).getByRole("link"));
      await expect(args.onClick).toHaveBeenCalled();
    },
    Loading: ({ canvasElement }: { canvasElement: HTMLElement }) => expect(within(canvasElement).getByRole("button").getAttribute("aria-busy")).toBe("true"),
    // A link has no `disabled`: it says so and leaves the tab order.
    "Disabled link": async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const anchor = within(canvasElement).getByRole("link");
      await expect([anchor.getAttribute("aria-disabled"), anchor.tabIndex]).toEqual(["true", -1]);
      await refusesChild(anchor, disabledLink.onClick);
    },
    "Loading link": async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const anchor = within(canvasElement).getByRole("link");
      await expect([anchor.getAttribute("aria-disabled"), anchor.getAttribute("aria-busy"), anchor.tabIndex]).toEqual(["true", "true", -1]);
      await refusesChild(anchor, loadingLink.onClick);
    },
  },
};

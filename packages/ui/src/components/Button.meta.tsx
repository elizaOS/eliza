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
    AsChild: link(),
    "Disabled link": { ...disabledLink, disabled: true },
    "Loading link": { ...loadingLink, loading: true },
    Empty: { size: "icon", "aria-label": "Add", children: undefined },
  },
  play: {
    AsChild: async ({ args, canvasElement }: { args: ButtonProps; canvasElement: HTMLElement }) => {
      await userEvent.click(within(canvasElement).getByRole("link"));
      await expect(args.onClick).toHaveBeenCalled();
    },
    Loading: ({ canvasElement }: { canvasElement: HTMLElement }) => expect(within(canvasElement).getByRole("button").getAttribute("aria-busy")).toBe("true"),
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

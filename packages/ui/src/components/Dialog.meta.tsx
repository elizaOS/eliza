import { expect, screen, userEvent, waitFor } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { CardFooter } from "./Card.tsx";
import { DialogClose, DialogContent, type DialogProps, DialogTitle, DialogTrigger } from "./Dialog.tsx";

const children = (
  <>
    <DialogTrigger asChild>
      <Button variant="destructive">Delete</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogTitle>Delete the order?</DialogTitle>
      <CardFooter>
        <DialogClose asChild>
          <Button variant="outline">Keep</Button>
        </DialogClose>
        <Button variant="destructive">Delete</Button>
      </CardFooter>
    </DialogContent>
  </>
);

export const meta: ComponentMeta<DialogProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
  play: {
    // Opened from the keyboard, it takes focus; Escape and the close button dismiss it, and focus goes back to the trigger.
    Default: async () => {
      // Focus goes back a moment after the dialog closes.
      const trigger = screen.getByRole("button", { name: "Delete" });
      trigger.focus();
      await userEvent.keyboard("{Enter}");
      await expect((await screen.findByRole("dialog", { name: "Delete the order?" })).contains(document.activeElement)).toBe(true);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect([screen.queryByRole("dialog"), document.activeElement]).toEqual([null, trigger]));
      await userEvent.click(trigger);
      await userEvent.click(await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect([screen.queryByRole("dialog"), document.activeElement]).toEqual([null, trigger]));
    },
  },
};

// spec/todo.md, "A new to-do needs a title and an id never used before; other edits need a live to-do"
// What Bombadil checks on every state it reaches while it clicks, types, scrolls and reloads the page served by
// `pnpm start` (SPEC.md, "Exploring the page"): its default properties and the Add button.
import { always } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";
export * from "@antithesishq/bombadil/browser/defaults";

const blankTitleRefused = extract(({ document }) => {
  const title = document.querySelector<HTMLInputElement>('input[aria-label="New to-do"]');
  const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
  return !title || !add || title.value.trim() !== "" || add.disabled;
});

/** Add is never offered for a title that is blank. */
export const blankTitleCannotBeAdded = always(() => blankTitleRefused.current);

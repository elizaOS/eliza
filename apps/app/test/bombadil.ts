// spec/app/index.md, "Every step adds exactly one greeting"; spec/app/index.md, "Only a name that is not empty can be greeted, and a link greets only a name not greeted last"
// What Bombadil checks on every state it reaches while it clicks, types, scrolls and reloads the page (SPEC.md,
// "Exploring the page"): its default properties, the greeter kept in the browser's storage, and the Greet button.
import { always, next, now } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";
export * from "@antithesishq/bombadil/browser/defaults";

const greetings = extract(({ window }) => (JSON.parse(window.localStorage.getItem("greeter") ?? "null") as { count: number } | null)?.count ?? 0);

const emptyNameRefused = extract(({ document }) => {
  const name = document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  const greet = [...document.querySelectorAll("button")].find((button) => button.textContent === "Greet");
  return !name || !greet || name.value !== "" || greet.disabled;
});

/**
 * No action loses a greeting, a reload or a step back included. A page opened from a link greets once it has loaded,
 * so the greeting it adds can land with the next action's: how many an action adds is the spec's to prove, not the page's.
 */
export const greetingsAreNeverLost = always(now(() => {
  const before = greetings.current;
  return next(() => greetings.current >= before);
}));

/** Greet is never offered for an empty name. */
export const emptyNameCannotBeGreeted = always(() => emptyNameRefused.current);

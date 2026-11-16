import { Layer, ManagedRuntime } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Machine } from "../gen/app.effect.vibe";
import { App } from "../src/App.tsx";
import { greeter } from "../src/greeter.vibe";
import { linkTo } from "../src/link.ts";

const opened: { root: Root; runtime: ManagedRuntime.ManagedRuntime<Machine, unknown> }[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

/** The page opened at `search`, over the browser's own localStorage, as main.tsx opens it. */
async function open(search = "") {
  for (const { root } of opened) await act(() => Promise.resolve(root.unmount()));
  const runtime = ManagedRuntime.make(Layer.provide(greeter, KeyValueStore.layerStorage(() => localStorage)));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  opened.push({ root, runtime });
  await act(() => Promise.resolve(root.render(<App runtime={runtime} search={search} />)));
}

beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const { root, runtime } of opened.splice(0)) { await act(() => Promise.resolve(root.unmount())); await runtime.dispose(); }
  localStorage.clear();
});
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

const storedGreeter = (): unknown => JSON.parse(localStorage.getItem("greeter") ?? "null");

/** Fills localStorage until it takes no more, as a browser's quota does. */
function fill() {
  for (let size = 1 << 22; size > 0; size >>= 1)
    for (let i = 0; ; i++) try { localStorage.setItem(`fill${size}.${i}`, "x".repeat(size)); } catch { break; }
}

// spec/app/index.md, "Story: Say hello"
// A link greets its name once, however often it is opened: typed after a second opening, Ada is the second greeting.
// Greeting disables the button that was clicked, and a browser then drops its focus: the page hands it to the name, so
// the next one is typed at once. The greeter is in the browser's own localStorage, at its quota in the end.
it("Say hello from a link, then one name after another, until the store is full", async () => {
  await open(linkTo("Ada"));
  await expect.poll(storedGreeter).toEqual({ name: "Ada", count: 1 });
  // spec/app/index.md, "Every step says hello to the name it greeted, once"; spec/app/words.md, "A page says hello to a name"
  await expect.element(page.getByRole("status").filter({ hasText: "Hello, Ada!" })).toBeInTheDocument();
  // spec/app/index.md, "Only a name that is not empty can be greeted, and a link greets only a name not greeted last"
  await open(linkTo("Ada"));

  const name = page.getByRole("textbox", { name: "Name" }), greet = page.getByRole("button", { name: "Greet" });
  await act(() => userEvent.type(name, "Ada"));
  await act(() => userEvent.click(greet));
  await expect.poll(storedGreeter).toEqual({ name: "Ada", count: 2 });
  await expect.poll(() => document.activeElement).toBe(name.element());
  await expect.element(greet).toBeDisabled();
  await act(() => userEvent.keyboard("Grace{Enter}"));
  await expect.poll(storedGreeter).toEqual({ name: "Grace", count: 3 });

  fill();
  await act(() => userEvent.keyboard("Margaret{Enter}"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(storedGreeter()).toEqual({ name: "Grace", count: 3 });
});

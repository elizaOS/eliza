import { Layer, ManagedRuntime } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/App.tsx";
import { stored } from "../src/greeter.vibe";

const runtime = ManagedRuntime.make(Layer.provide(stored, KeyValueStore.layerStorage(() => localStorage)));
const root = createRoot(document.body.appendChild(document.createElement("div")));
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => Promise.resolve(root.unmount())); await runtime.dispose(); localStorage.clear(); });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

const storedGreeter = (): unknown => JSON.parse(localStorage.getItem("greeter") ?? "null");

/** Fills localStorage until it takes no more, as a browser's quota does. */
function fill() {
  for (let size = 1 << 22; size > 0; size >>= 1)
    for (let i = 0; ; i++) try { localStorage.setItem(`fill${size}.${i}`, "x".repeat(size)); } catch { break; }
}

// spec/app/index.md, "Story: Say hello"
// Greeting disables the button that was clicked, and a browser then drops its focus: the page hands it to the name,
// so the next one is typed at once. The greeter is in the browser's own localStorage, at its quota in the end.
it("Say hello, one name after another, until the store is full", async () => {
  await act(() => Promise.resolve(root.render(<App runtime={runtime} />)));
  const name = page.getByRole("textbox", { name: "Name" }), greet = page.getByRole("button", { name: "Greet" });
  await act(() => userEvent.type(name, "Ada"));
  await act(() => userEvent.click(greet));
  await expect.poll(storedGreeter).toEqual({ name: "Ada", count: 1 });
  await expect.poll(() => document.activeElement).toBe(name.element());
  // spec/app/index.md, "Only a name that is not empty can be greeted"
  await expect.element(greet).toBeDisabled();
  await act(() => userEvent.keyboard("Grace{Enter}"));
  await expect.poll(storedGreeter).toEqual({ name: "Grace", count: 2 });

  fill();
  await act(() => userEvent.keyboard("Margaret{Enter}"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(storedGreeter()).toEqual({ name: "Grace", count: 2 });
});

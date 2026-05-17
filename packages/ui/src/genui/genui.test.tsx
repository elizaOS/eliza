// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createElizaGenUiPrefixActionHandler } from "./actions";
import { ElizaGenUiRenderer } from "./renderer";
import { ELIZA_STARTER_PACK_SETUP_SPEC } from "./starter-pack-demo";
import { applyElizaGenUiPatch } from "./streaming";
import type { ElizaGenUiSpec } from "./types";
import { validateElizaGenUiSpec } from "./validator";

const primitiveSpec: ElizaGenUiSpec = {
  version: "0.1",
  a2uiVersion: "0.9",
  root: "card",
  components: [
    { id: "card", component: "Card", child: "column" },
    { id: "column", component: "Column", children: ["title", "action"] },
    { id: "title", component: "Text", text: "Hello", variant: "h2" },
    {
      id: "action",
      component: "Button",
      child: "action-text",
      action: { event: { name: "setup.dismiss" } },
    },
    { id: "action-text", component: "Text", text: "Continue" },
  ],
};

afterEach(() => cleanup());

describe("Eliza GenUI", () => {
  it("validates a primitive A2UI-like spec", () => {
    expect(validateElizaGenUiSpec(primitiveSpec).ok).toBe(true);
  });

  it("rejects an unknown component", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      components: [{ id: "root", component: "Shell" }],
      root: "root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "unknown_component"),
      ).toBe(true);
    }
  });

  it("rejects duplicate component ids", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      components: [
        { id: "root", component: "Column" },
        { id: "root", component: "Text", text: "duplicate" },
      ],
      root: "root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "duplicate_id")).toBe(
        true,
      );
    }
  });

  it("rejects a missing root", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      root: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "invalid_root")).toBe(
        true,
      );
    }
  });

  it("rejects missing child references", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      components: [{ id: "root", component: "Card", child: "missing" }],
      root: "root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "missing_child"),
      ).toBe(true);
    }
  });

  it("rejects unsafe image URLs", () => {
    const result = validateElizaGenUiSpec({
      version: "0.1",
      a2uiVersion: "0.9",
      root: "image",
      components: [
        { id: "image", component: "Image", src: "javascript:alert(1)" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "unsafe_url")).toBe(
        true,
      );
    }
  });

  it("rejects arbitrary script fields", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      components: [
        { id: "root", component: "Text", text: "bad", script: "run()" },
      ],
      root: "root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "unsafe_field")).toBe(
        true,
      );
    }
  });

  it("rejects unknown action events", () => {
    const result = validateElizaGenUiSpec({
      ...primitiveSpec,
      components: [
        {
          id: "root",
          component: "Button",
          text: "Run",
          action: { event: { name: "shell.run" } },
        },
      ],
      root: "root",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "invalid_action"),
      ).toBe(true);
    }
  });

  it("renders Text, Button, Card, and Column", async () => {
    const seen: string[] = [];
    const handler = createElizaGenUiPrefixActionHandler(
      ["setup."],
      async (action) => {
        seen.push(action.event.name);
        return { ok: true };
      },
    );
    render(
      <ElizaGenUiRenderer spec={primitiveSpec} actionHandlers={[handler]} />,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(seen).toEqual(["setup.dismiss"]));
  });

  it("applies replace patches", () => {
    const result = applyElizaGenUiPatch(primitiveSpec, [
      { op: "replace", path: "/components/2/text", value: "Updated" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.components[2].text).toBe("Updated");
    }
  });

  it("invalidates bad remove patches", () => {
    const result = applyElizaGenUiPatch(primitiveSpec, [
      { op: "remove", path: "/components/2" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "missing_child"),
      ).toBe(true);
    }
  });

  it("applies remove patches", () => {
    const spec: ElizaGenUiSpec = {
      version: "0.1",
      a2uiVersion: "0.9",
      root: "column",
      components: [
        { id: "column", component: "Column", children: ["keep"] },
        { id: "keep", component: "Text", text: "Keep" },
        { id: "unused", component: "Text", text: "Remove" },
      ],
    };
    const result = applyElizaGenUiPatch(spec, [
      { op: "remove", path: "/components/2" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.components.map((component) => component.id)).toEqual([
        "column",
        "keep",
      ]);
    }
  });

  it("validates the starter setup card", () => {
    expect(validateElizaGenUiSpec(ELIZA_STARTER_PACK_SETUP_SPEC).ok).toBe(true);
  });
});

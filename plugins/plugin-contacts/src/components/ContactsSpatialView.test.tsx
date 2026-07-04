/**
 * Render tests for ContactsSpatialView — the one source rendered across three
 * modalities (TUI terminal lines, GUI DOM, XR). Covers list/detail/new modes
 * and terminal-view registration. Deterministic static markup, no live runtime.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ContactsSnapshot,
  ContactsSpatialView,
} from "./ContactsSpatialView.tsx";

const snapshot: ContactsSnapshot = {
  mode: "list",
  query: "lov",
  contacts: [
    {
      id: "c1",
      lookupKey: "lk1",
      displayName: "Ada Lovelace",
      phoneNumbers: ["+15550100"],
      emailAddresses: ["ada@analytical.engine"],
      starred: true,
    },
    {
      id: "c2",
      lookupKey: "lk2",
      displayName: "Grace Hopper",
      phoneNumbers: ["+15550200"],
      emailAddresses: [],
      starred: false,
    },
  ],
};

const view = <ContactsSpatialView snapshot={snapshot} />;

describe("ContactsSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Ada Lovelace");
      expect(flat).toContain("Grace Hopper");
      expect(flat).toContain("Search");
      expect(flat).toContain("New");
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Ada Lovelace");
      expect(html).toContain("Grace Hopper");
      expect(html).toContain('data-agent-id="new"');
      expect(html).toContain('data-agent-id="select:c1"');
    }
  });

  it("detail mode renders the selected contact with call/text actions", () => {
    const detail: ContactsSnapshot = {
      ...snapshot,
      mode: "detail",
      selectedId: "c1",
    };
    const lines = renderViewToLines(
      <ContactsSpatialView snapshot={detail} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Ada Lovelace");
    expect(flat).toContain("+15550100");
    expect(flat).toContain("Call");
    expect(flat).toContain("Text");
  });

  it("new mode renders the creation form", () => {
    const create: ContactsSnapshot = {
      mode: "new",
      query: "",
      contacts: [],
      form: {
        displayName: "Katherine Johnson",
        phoneNumber: "+15550300",
        emailAddress: "kj@orbital.math",
      },
    };
    const lines = renderViewToLines(
      <ContactsSpatialView snapshot={create} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Name");
    expect(flat).toContain("Save");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("contacts-test", () => view);
    try {
      const component = getTerminalView("contacts-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Ada Lovelace");
    } finally {
      unregister();
    }
  });
});

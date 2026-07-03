// @vitest-environment jsdom
//
// Native HTML5 drag-to-reorder coverage for the plugin catalog (#10722). The
// PluginCard rows are `draggable` and the reorder is driven entirely by native
// dragstart → dragover → drop events wired through PluginListView. Before this
// there was zero coverage, so a regression in the splice/persist logic (dropped
// order, a duplicated id, an `undefined` slot, or a lost localStorage write)
// would ship silently.
//
// These tests dispatch real drag events and assert the SEMANTIC outcome: the
// rendered card order actually changes, the new order persists to
// localStorage, the persisted list has no duplicate/undefined ids, and a drop
// onto the same card is a no-op (nothing reordered, nothing persisted).

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";
import { PluginsView } from "./PluginsView";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const clientMock = vi.hoisted(() => ({
  onWsEvent: vi.fn(() => () => {}),
  testPluginConnection: vi.fn(),
  installRegistryPlugin: vi.fn(),
  updateRegistryPlugin: vi.fn(),
  uninstallRegistryPlugin: vi.fn(),
  restartAndWait: vi.fn(),
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));
vi.mock("../../api", () => ({ client: clientMock }));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    plugins: [] as PluginInfo[],
    pluginStatusFilter: "all",
    pluginSearch: "",
    pluginSettingsOpen: new Set<string>(),
    pluginSaving: null,
    pluginSaveSuccess: null,
    loadPlugins: vi.fn(async () => {}),
    ensurePluginsLoaded: vi.fn(async () => {}),
    handlePluginToggle: vi.fn(async () => {}),
    handlePluginConfigSave: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    t,
    ...overrides,
  };
}

// Three sibling "connector"-group plugins with alphabetical names. With no
// custom order yet, comparePlugins sorts ready plugins by name, so the initial
// DOM order is [alpha, bravo, charlie].
function makePlugin(id: string, name: string): PluginInfo {
  return {
    id,
    name,
    description: `${name} plugin`,
    enabled: true,
    configured: true,
    envKey: null,
    category: "feature",
    group: "connector",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: true,
  } as PluginInfo;
}

/** A DataTransfer stand-in (jsdom has none) exposing what the handlers touch. */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    dropEffect: "none",
    effectAllowed: "all",
    types: [] as string[],
    setData: (key: string, value: string) => {
      store[key] = value;
    },
    getData: (key: string) => store[key] ?? "",
    setDragImage: () => {},
  };
}

function orderInDom(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-plugin-id]")).map((el) =>
    el.getAttribute("data-plugin-id"),
  ) as string[];
}

function card(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-plugin-id="${id}"]`);
  if (!el) throw new Error(`no card for ${id}`);
  return el as HTMLElement;
}

/** Perform a full native drag of `srcId` and drop it onto `targetId`. */
function dragAndDrop(container: HTMLElement, srcId: string, targetId: string) {
  const dataTransfer = makeDataTransfer();
  fireEvent.dragStart(card(container, srcId), { dataTransfer });
  fireEvent.dragOver(card(container, targetId), { dataTransfer });
  fireEvent.drop(card(container, targetId), { dataTransfer });
}

beforeEach(() => {
  localStorage.clear();
  clientMock.onWsEvent.mockClear();
  appMock.value = makeContext({
    plugins: [
      makePlugin("alpha", "Alpha"),
      makePlugin("bravo", "Bravo"),
      makePlugin("charlie", "Charlie"),
    ],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("PluginsView — native drag-to-reorder", () => {
  it("renders the three connector plugins in alphabetical order at rest", () => {
    const { container } = render(<PluginsView />);
    expect(orderInDom(container)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("reorders cards and persists the new order when a card is dropped ahead of another", async () => {
    const { container } = render(<PluginsView />);
    expect(orderInDom(container)).toEqual(["alpha", "bravo", "charlie"]);

    // Drag Charlie to the front (drop it onto Alpha).
    dragAndDrop(container, "charlie", "alpha");

    await waitFor(() =>
      expect(orderInDom(container)).toEqual(["charlie", "alpha", "bravo"]),
    );

    // The order persisted to localStorage and is well-formed: every entry is a
    // defined, unique id (no duplicate/undefined slot from a bad splice).
    const stored = JSON.parse(
      localStorage.getItem("pluginOrder") ?? "null",
    ) as string[];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.filter((id) => id == null)).toHaveLength(0);
    expect(new Set(stored).size).toBe(stored.length);
    // The three real plugins keep their new relative order in the persisted list.
    expect(stored.filter((id) => id !== "__ui-showcase__")).toEqual([
      "charlie",
      "alpha",
      "bravo",
    ]);
  });

  it("moves a card backward when dropped onto a later sibling", async () => {
    const { container } = render(<PluginsView />);

    // Drag Alpha down onto Charlie.
    dragAndDrop(container, "alpha", "charlie");

    await waitFor(() =>
      expect(orderInDom(container)).toEqual(["bravo", "charlie", "alpha"]),
    );
  });

  it("does not reorder or persist when a card is dropped onto itself (no movement)", async () => {
    const { container } = render(<PluginsView />);
    expect(orderInDom(container)).toEqual(["alpha", "bravo", "charlie"]);

    dragAndDrop(container, "bravo", "bravo");

    // Give any state update a tick — nothing should have changed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orderInDom(container)).toEqual(["alpha", "bravo", "charlie"]);
    // A no-op drop never writes a custom order.
    expect(localStorage.getItem("pluginOrder")).toBeNull();
  });

  it("survives a second reorder without duplicating or dropping any id", async () => {
    const { container } = render(<PluginsView />);

    dragAndDrop(container, "charlie", "alpha"); // → charlie, alpha, bravo
    await waitFor(() =>
      expect(orderInDom(container)).toEqual(["charlie", "alpha", "bravo"]),
    );

    dragAndDrop(container, "bravo", "charlie"); // bravo to the front
    await waitFor(() =>
      expect(orderInDom(container)).toEqual(["bravo", "charlie", "alpha"]),
    );

    const stored = JSON.parse(
      localStorage.getItem("pluginOrder") ?? "null",
    ) as string[];
    const real = stored.filter((id) => id !== "__ui-showcase__");
    expect(real).toEqual(["bravo", "charlie", "alpha"]);
    expect(new Set(stored).size).toBe(stored.length);
    expect(stored.filter((id) => id == null)).toHaveLength(0);
  });
});

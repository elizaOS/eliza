// @vitest-environment jsdom
//
// Behavioral test for the custom-actions LIST panel (CustomActionsPanel). This
// is the surface that renders persisted custom actions and drives their
// lifecycle: enable/disable toggle, delete-with-confirm, and open-editor
// (edit vs. create). We drive the real component and assert the exact calls it
// makes to the API boundary + the resulting list mutation. The authoring form
// itself is covered by CustomActionEditor.test.tsx — this file does NOT
// duplicate it; it only asserts the list-side wiring (onOpenEditor payloads,
// toggle/delete calls, optimistic list updates, empty/error states).

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomActionDef } from "@elizaos/shared";
import { installJsdomUiPolyfills } from "../../../test/portable-stories";

// ── Collaborator mocks ────────────────────────────────────────────────
// Unit under test: CustomActionsPanel. We mock only the API transport, the
// desktop confirm dialog, and the app-state selector (t).
const clientMock = vi.hoisted(() => ({
  listCustomActions: vi.fn(),
  updateCustomAction: vi.fn(),
  deleteCustomAction: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../utils/desktop-dialogs", () => ({
  confirmDesktopAction: confirmMock,
}));

// t() mirrors the real i18n contract: return the caller-supplied defaultValue
// (interpolating {{vars}} from opts) when present, else the raw key. Defined
// ONCE at module scope so its identity is stable across renders — loadActions
// and the format callbacks depend on t; a per-render t would loop the effect.
const tFn = (
  key: string,
  opts?: Record<string, string | number> & { defaultValue?: string },
): string => {
  const template = opts?.defaultValue ?? key;
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
    name in opts ? String(opts[name]) : `{{${name}}}`,
  );
};

vi.mock("../../state", () => ({
  useAppSelector: (sel: (v: { t: typeof tFn }) => unknown) => sel({ t: tFn }),
}));

import { CustomActionsPanel } from "./CustomActionsPanel";

function makeAction(over: Partial<CustomActionDef> = {}): CustomActionDef {
  return {
    id: over.id ?? "act-1",
    name: over.name ?? "PING_HOST",
    description: over.description ?? "Pings a host",
    similes: over.similes ?? [],
    parameters: over.parameters ?? [],
    handler: over.handler ?? { type: "http", method: "GET", url: "https://x.example.com" },
    enabled: over.enabled ?? false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function renderPanel(props?: {
  open?: boolean;
  onClose?: () => void;
  onOpenEditor?: (a?: CustomActionDef | null) => void;
}) {
  const onClose = props?.onClose ?? vi.fn();
  const onOpenEditor = props?.onOpenEditor ?? vi.fn();
  render(
    <CustomActionsPanel
      open={props?.open ?? true}
      onClose={onClose}
      onOpenEditor={onOpenEditor}
    />,
  );
  return { onClose, onOpenEditor };
}

// Locate the card <div> that owns a given action name so we can scope
// switch/edit/delete queries to that row.
function cardFor(name: string): HTMLElement {
  const heading = screen.getByText(name);
  // name -> min-w-0 wrapper -> flex row -> card
  const card = heading.closest("div.border") as HTMLElement | null;
  if (!card) throw new Error(`card not found for ${name}`);
  return card;
}

beforeEach(() => {
  installJsdomUiPolyfills();
  clientMock.listCustomActions.mockReset();
  clientMock.updateCustomAction.mockReset();
  clientMock.deleteCustomAction.mockReset();
  confirmMock.mockReset();
  clientMock.updateCustomAction.mockResolvedValue(undefined);
  clientMock.deleteCustomAction.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("CustomActionsPanel — list rendering", () => {
  it("loads and renders each persisted action with an accurate total/enabled summary", async () => {
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST", enabled: true }),
      makeAction({ id: "b", name: "DISK_USAGE", enabled: false, handler: { type: "shell", command: "df -h" } }),
    ]);
    renderPanel();

    await screen.findByText("PING_HOST");
    expect(screen.getByText("DISK_USAGE")).toBeTruthy();
    // Summary computed in-component: 2 total, 1 enabled.
    expect(screen.getByText("2 total · 1 enabled")).toBeTruthy();
    // Handler-type badge label reflects each action's handler.
    expect(screen.getByText("HTTP")).toBeTruthy();
    expect(screen.getByText("Shell")).toBeTruthy();
  });

  it("does not fetch or render list content while closed (self-hide)", () => {
    clientMock.listCustomActions.mockResolvedValue([makeAction({ name: "HIDDEN_ONE" })]);
    renderPanel({ open: false });
    expect(clientMock.listCustomActions).not.toHaveBeenCalled();
    expect(screen.queryByText("HIDDEN_ONE")).toBeNull();
  });
});

describe("CustomActionsPanel — empty & error states", () => {
  it("shows the empty-state copy when there are no actions", async () => {
    clientMock.listCustomActions.mockResolvedValue([]);
    renderPanel();
    await screen.findByText("No custom actions yet. Make one to get started.");
  });

  it("shows a load-failure message and no rows when the transport rejects", async () => {
    clientMock.listCustomActions.mockRejectedValueOnce(new Error("network down"));
    renderPanel();
    await screen.findByText("Couldn't load custom actions. Try again.");
    expect(screen.queryByText("PING_HOST")).toBeNull();
  });

  it("filters the list by search and shows the no-match copy when nothing matches", async () => {
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST" }),
      makeAction({ id: "b", name: "DISK_USAGE" }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    const search = screen.getByPlaceholderText("customactionspanel.SearchByNameDesc");
    fireEvent.change(search, { target: { value: "disk" } });
    expect(screen.queryByText("PING_HOST")).toBeNull();
    expect(screen.getByText("DISK_USAGE")).toBeTruthy();

    fireEvent.change(search, { target: { value: "zzz-nomatch" } });
    await screen.findByText("Nothing matches that search.");
  });
});

describe("CustomActionsPanel — enable/disable toggle", () => {
  it("calls updateCustomAction(id, {enabled}) and flips the row's checked state", async () => {
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST", enabled: false }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    const toggle = within(cardFor("PING_HOST")).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await vi.waitFor(() =>
      expect(clientMock.updateCustomAction).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.updateCustomAction.mock.calls[0]).toEqual([
      "a",
      { enabled: true },
    ]);
    // Optimistic list mutation: row now reads enabled, and the summary recomputes.
    await vi.waitFor(() =>
      expect(
        within(cardFor("PING_HOST")).getByRole("switch").getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(screen.getByText("1 total · 1 enabled")).toBeTruthy();
  });

  it("surfaces an update-failure message without desyncing the list", async () => {
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST", enabled: false }),
    ]);
    clientMock.updateCustomAction.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    await screen.findByText("PING_HOST");

    fireEvent.click(within(cardFor("PING_HOST")).getByRole("switch"));
    await screen.findByText("Couldn't update this action. Try again.");
    // Failed update must NOT optimistically flip the row.
    expect(
      within(cardFor("PING_HOST")).getByRole("switch").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("rapid double-toggle settles on the intended state (no flicker back)", async () => {
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST", enabled: false }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    const toggle = within(cardFor("PING_HOST")).getByRole("switch");
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await vi.waitFor(() =>
      expect(clientMock.updateCustomAction).toHaveBeenCalled(),
    );
    // Both synchronous clicks read the same pre-render enabled=false, so each
    // requests enabled:true — the row lands enabled, never flickered back off.
    for (const call of clientMock.updateCustomAction.mock.calls) {
      expect(call).toEqual(["a", { enabled: true }]);
    }
    await vi.waitFor(() =>
      expect(
        within(cardFor("PING_HOST")).getByRole("switch").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});

describe("CustomActionsPanel — delete with confirm", () => {
  it("confirms, deletes via the API, and removes the row on confirm", async () => {
    confirmMock.mockResolvedValue(true);
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST" }),
      makeAction({ id: "b", name: "DISK_USAGE" }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    fireEvent.click(
      within(cardFor("PING_HOST")).getByRole("button", { name: "common.delete" }),
    );

    await vi.waitFor(() =>
      expect(clientMock.deleteCustomAction).toHaveBeenCalledWith("a"),
    );
    // Row is removed from the list; the other action stays.
    await vi.waitFor(() => expect(screen.queryByText("PING_HOST")).toBeNull());
    expect(screen.getByText("DISK_USAGE")).toBeTruthy();
    // The confirm dialog was actually shown with the action's name.
    expect(confirmMock.mock.calls[0][0].message).toBe(
      "customactionsview.DeleteCustomActionMessage",
    );
  });

  it("does NOT delete when the confirm is declined", async () => {
    confirmMock.mockResolvedValue(false);
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST" }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    fireEvent.click(
      within(cardFor("PING_HOST")).getByRole("button", { name: "common.delete" }),
    );

    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(clientMock.deleteCustomAction).not.toHaveBeenCalled();
    // Row is still present.
    expect(screen.getByText("PING_HOST")).toBeTruthy();
  });

  it("shows a delete-failure message and keeps the row when the API rejects", async () => {
    confirmMock.mockResolvedValue(true);
    clientMock.deleteCustomAction.mockRejectedValueOnce(new Error("locked"));
    clientMock.listCustomActions.mockResolvedValue([
      makeAction({ id: "a", name: "PING_HOST" }),
    ]);
    renderPanel();
    await screen.findByText("PING_HOST");

    fireEvent.click(
      within(cardFor("PING_HOST")).getByRole("button", { name: "common.delete" }),
    );
    await screen.findByText("Couldn't delete this action. Try again.");
    expect(screen.getByText("PING_HOST")).toBeTruthy();
  });
});

describe("CustomActionsPanel — open editor", () => {
  it("opens the editor with the exact action when Edit is clicked", async () => {
    const target = makeAction({ id: "a", name: "PING_HOST" });
    clientMock.listCustomActions.mockResolvedValue([target]);
    const { onOpenEditor } = renderPanel();
    await screen.findByText("PING_HOST");

    fireEvent.click(
      within(cardFor("PING_HOST")).getByRole("button", { name: "common.edit" }),
    );
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect(onOpenEditor.mock.calls[0][0]).toBe(target);
  });

  it("opens the editor for a NEW action (null) from the create button", async () => {
    clientMock.listCustomActions.mockResolvedValue([]);
    const { onOpenEditor } = renderPanel();
    await screen.findByText("No custom actions yet. Make one to get started.");

    fireEvent.click(screen.getByText("customactionspanel.NewCustomAction"));
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect(onOpenEditor.mock.calls[0][0]).toBeNull();
  });

  it("fires onClose from the header close button", async () => {
    clientMock.listCustomActions.mockResolvedValue([]);
    const { onClose } = renderPanel();
    await screen.findByText("No custom actions yet. Make one to get started.");
    fireEvent.click(screen.getByRole("button", { name: "aria.closePanel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

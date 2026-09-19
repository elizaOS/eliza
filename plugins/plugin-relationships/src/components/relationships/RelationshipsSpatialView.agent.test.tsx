/**
 * Exercises the real React/Radix filter and semantic registry together, including
 * keyboard focus restoration, filtering, teardown, and error-action dispatch.
 */
// @vitest-environment jsdom
import {
  AgentSurfaceProvider,
  getViewRegistry,
} from "@elizaos/ui/agent-surface";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  type RelationshipsSnapshot,
  RelationshipsSpatialView,
} from "./RelationshipsSpatialView.tsx";

afterEach(cleanup);

const snapshot: RelationshipsSnapshot = {
  state: "ready",
  nodes: [
    {
      id: "person",
      kind: "person",
      kindLabel: "People",
      name: "Synthetic Person",
      identityLine: "",
      edges: [],
    },
    {
      id: "organization",
      kind: "organization",
      kindLabel: "Organizations",
      name: "Synthetic Organization",
      identityLine: "",
      edges: [],
    },
  ],
  filters: [
    { kind: "person", label: "People" },
    { kind: "organization", label: "Organizations" },
  ],
};

it("opens and selects the real filter through the registry while retaining Radix focus and teardown", async () => {
  const viewId = "relationships-filter-contract";
  const view = render(
    <AgentSurfaceProvider viewId={viewId}>
      <RelationshipsSpatialView snapshot={snapshot} />
    </AgentSurfaceProvider>,
  );
  const registry = getViewRegistry(viewId, "gui");
  if (!registry)
    throw new Error("The mounted provider did not register its view");
  const trigger = view.getByRole("button", {
    name: /Filter relationship type/,
  });
  await act(async () => {
    expect(registry.focus("relationships-kind-filter").ok).toBe(true);
  });
  expect(document.activeElement).toBe(trigger);
  await act(async () => {
    expect(registry.click("relationships-kind-filter").ok).toBe(true);
  });
  await view.findByRole("menuitemradio", { name: "Organizations" });
  await act(async () => {
    expect(registry.click("relationships-kind-organization").ok).toBe(true);
  });
  await waitFor(() => {
    expect(view.queryByText("Synthetic Person")).toBeNull();
    expect(view.getByText("Synthetic Organization")).toBeTruthy();
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });
  const menu = await view.findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  view.unmount();
  expect(getViewRegistry(viewId, "gui")).toBeUndefined();
});

it("dispatches retry from the real error boundary control through the registry", async () => {
  const actions: string[] = [];
  const viewId = "relationships-error-contract";
  render(
    <AgentSurfaceProvider viewId={viewId}>
      <RelationshipsSpatialView
        snapshot={{
          state: "error",
          nodes: [],
          filters: [],
          error: "Unavailable",
        }}
        onAction={(action) => actions.push(action)}
      />
    </AgentSurfaceProvider>,
  );
  const registry = getViewRegistry(viewId, "gui");
  if (!registry)
    throw new Error("The mounted provider did not register its view");
  await act(async () => {
    expect(registry.click("retry").ok).toBe(true);
  });
  expect(actions).toEqual(["retry"]);
});

// @vitest-environment jsdom
//
// Verifies the chat-overlay inline-widget renderer (#8997): assistant text with
// inline-widget markers renders the real widgets (choice / form / followups /
// task) and never leaks the raw `[CHOICE]`/`[FORM]`/`[TASK]`/`[FOLLOWUPS]`
// marker syntax as text; plain replies pass through unchanged.

import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

import { InlineWidgetText } from "./InlineWidgetText";
// The task widget is plugin-owned (registered by plugin-task-coordinator at
// boot, not a built-in); register it here so this surface renders it too.
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("InlineWidgetText", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders plain text unchanged (fast path)", () => {
    const { container } = withApp(
      <InlineWidgetText content="just a normal reply" />,
    );
    expect(container.textContent).toContain("just a normal reply");
  });

  it("renders a choice picker and does not leak the [CHOICE] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={
          "Approve this?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]"
        }
      />,
    );
    expect(container.textContent ?? "").toContain("Approve");
    expect(container.textContent ?? "").not.toContain("[CHOICE");
    expect(container.textContent ?? "").not.toContain("[/CHOICE]");
  });

  it("renders an inline form and does not leak the [FORM] marker", () => {
    const form = JSON.stringify({
      title: "Trip details",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    });
    const { container } = withApp(
      <InlineWidgetText content={`Fill this out:\n[FORM]\n${form}\n[/FORM]`} />,
    );
    expect(container.textContent ?? "").toContain("Destination");
    expect(container.textContent ?? "").not.toContain("[FORM]");
  });

  it("renders suggestion chips and does not leak the [FOLLOWUPS] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={"Done.\n[FOLLOWUPS]\nrerun=Run again\n[/FOLLOWUPS]"}
      />,
    );
    expect(container.textContent ?? "").toContain("Run again");
    expect(container.textContent ?? "").not.toContain("[FOLLOWUPS]");
  });

  it("renders a task card and does not leak the [TASK] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={`Created it.\n[TASK:${"a".repeat(12)}]Build the thing[/TASK]\nThe builders are running.`}
      />,
    );
    // The surrounding prose still renders, and the raw marker is gone (replaced
    // by the registered task widget).
    expect(container.textContent ?? "").toContain("Created it.");
    expect(container.textContent ?? "").toContain("The builders are running.");
    expect(container.textContent ?? "").not.toContain("[TASK:");
    expect(container.textContent ?? "").not.toContain("[/TASK]");
  });
});

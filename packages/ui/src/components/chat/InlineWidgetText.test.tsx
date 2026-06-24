// @vitest-environment jsdom
//
// Verifies the chat-overlay inline-widget renderer (#8997, #9304): assistant
// text with inline-widget markers renders the real widgets (choice / form /
// followups / task) and never leaks the raw `[CHOICE]`/`[FORM]`/`[TASK]`/
// `[FOLLOWUPS]` marker syntax as text; plain replies pass through unchanged.
// Since #9304 the overlay shares the full ChatView's `parseSegments`, so it also
// renders fenced code blocks and strips the structured/hidden markers
// (`[CONFIG:…]`, fenced UiSpec JSON, `<think>` blocks) instead of leaking them.

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

  // #9304: the overlay previously re-implemented a partial parser that only knew
  // the inline-widget markers, so the structured/hidden markers below leaked as
  // raw text. Sharing the full ChatView `parseSegments` closes that drift.

  it("does not leak a [CONFIG:…] marker (full-surface-only affordance)", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={"Configure it:\n[CONFIG:some-plugin]\nThanks."}
      />,
    );
    expect(container.textContent ?? "").toContain("Configure it:");
    expect(container.textContent ?? "").toContain("Thanks.");
    expect(container.textContent ?? "").not.toContain("[CONFIG");
    expect(container.textContent ?? "").not.toContain("some-plugin");
  });

  it("renders a fenced code block instead of leaking the raw fence", () => {
    const { container, queryByTestId } = withApp(
      <InlineWidgetText
        content={"Here is the snippet:\n```ts\nconst x = 1;\n```\nDone."}
      />,
    );
    expect(queryByTestId("code-block")).not.toBeNull();
    expect(container.textContent ?? "").toContain("const x = 1;");
    expect(container.textContent ?? "").toContain("Here is the snippet:");
    expect(container.textContent ?? "").not.toContain("```");
  });

  it("strips hidden <think> reasoning blocks (never shown to the user)", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={"Visible answer.<think>secret chain of thought</think> More."}
      />,
    );
    expect(container.textContent ?? "").toContain("Visible answer.");
    expect(container.textContent ?? "").toContain("More.");
    expect(container.textContent ?? "").not.toContain(
      "secret chain of thought",
    );
    expect(container.textContent ?? "").not.toContain("<think>");
  });

  it("does not leak a fenced UiSpec JSON block as raw text", () => {
    // Valid UiSpec shape (root: string + elements: object) so parseSegments
    // classifies it as a ui-spec region (dropped on the overlay), not code.
    const spec = JSON.stringify({
      root: "n1",
      elements: { n1: { type: "Text", text: "hi" } },
    });
    const { container } = withApp(
      <InlineWidgetText
        content={`Rendering UI:\n\`\`\`json\n${spec}\n\`\`\`\nOk.`}
      />,
    );
    expect(container.textContent ?? "").toContain("Rendering UI:");
    expect(container.textContent ?? "").toContain("Ok.");
    // The raw JSON keys / fence must not leak as literal text.
    expect(container.textContent ?? "").not.toContain('"elements"');
    expect(container.textContent ?? "").not.toContain("```");
  });
});

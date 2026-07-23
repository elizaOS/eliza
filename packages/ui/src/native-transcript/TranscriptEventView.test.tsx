// @vitest-environment jsdom
//
// Renderer tests: the web/DOM view paints one row per reduced item and exposes
// transport state via data attributes, all from structural fields. Real jsdom
// render via @testing-library; the parser + CodeBlock are the production ones.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptEvent } from "./contract";
import { TranscriptEventView } from "./TranscriptEventView";

afterEach(cleanup);

describe("TranscriptEventView", () => {
  it("renders user/agent/tool rows with structural status attributes", () => {
    const events: TranscriptEvent[] = [
      { type: "stt.final", seq: 1, turnId: "t1", text: "hello world" },
      {
        type: "agent.text",
        seq: 2,
        messageId: "m1",
        turnId: "t1",
        text: "Hi there!",
        final: true,
      },
      {
        type: "tool.state",
        seq: 3,
        callId: "c1",
        name: "search",
        phase: "succeeded",
        turnId: "t1",
      },
    ];
    const { container, getByText } = render(
      <TranscriptEventView events={events} />,
    );

    const user = container.querySelector('[data-role="user"]');
    expect(user?.getAttribute("data-status")).toBe("final");
    expect(getByText("hello world")).toBeTruthy();
    expect(getByText("hello world").getAttribute("dir")).toBe("auto");

    expect(
      container
        .querySelector('[data-role="agent"]')
        ?.getAttribute("data-status"),
    ).toBe("final");
    expect(
      container
        .querySelector('[data-role="tool"]')
        ?.getAttribute("data-status"),
    ).toBe("succeeded");
  });

  it("renders agent code segments through the shared CodeBlock primitive", () => {
    const events: TranscriptEvent[] = [
      {
        type: "agent.text",
        seq: 1,
        messageId: "m1",
        text: "Here:\n```js\nconst x = 1;\n```",
        final: true,
      },
    ];
    const { container } = render(<TranscriptEventView events={events} />);
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.textContent).toContain("const x = 1");
  });

  it("renders a permission-denied error as a distinct alert row", () => {
    const events: TranscriptEvent[] = [
      {
        type: "error",
        seq: 1,
        code: "permission-denied",
        retryable: false,
        message: "Mic denied",
      },
    ];
    const { container, getByRole } = render(
      <TranscriptEventView events={events} />,
    );
    const alert = getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("permission-denied");
    expect(alert.getAttribute("data-retryable")).toBe("false");
    expect(container.textContent).toContain("Mic denied");
  });

  it("carries RTL/Unicode text verbatim and lets the browser bidi-resolve it", () => {
    const events: TranscriptEvent[] = [
      { type: "stt.final", seq: 1, turnId: "t1", text: "مرحبا بالعالم" },
    ];
    const { getByText } = render(<TranscriptEventView events={events} />);
    const el = getByText("مرحبا بالعالم");
    expect(el.getAttribute("dir")).toBe("auto");
  });

  it("exposes live speaking + connection state on the container", () => {
    const events: TranscriptEvent[] = [
      { type: "agent.text", seq: 1, messageId: "m1", text: "hi", final: true },
      {
        type: "tts.audio",
        seq: 2,
        utteranceId: "u1",
        phase: "started",
        messageId: "m1",
      },
      { type: "reconnect", seq: 3, phase: "lost", attempt: 1 },
    ];
    const { container } = render(<TranscriptEventView events={events} />);
    const root = container.querySelector('[data-testid="native-transcript"]');
    expect(root?.getAttribute("data-speaking")).toBe("u1");
    expect(root?.getAttribute("data-connection")).toBe("lost");
    expect(
      container
        .querySelector('[data-role="reconnect"]')
        ?.getAttribute("data-phase"),
    ).toBe("lost");
  });
});

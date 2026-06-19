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
  type MessagesSnapshot,
  MessagesSpatialView,
} from "./MessagesSpatialView.tsx";

const snapshot: MessagesSnapshot = {
  threads: [
    {
      id: "t1",
      address: "+15550100",
      unreadCount: 2,
      lastMessage: {
        id: "m2",
        threadId: "t1",
        address: "+15550100",
        body: "see you at noon",
        date: 200,
        type: 1,
        read: false,
      },
      messages: [
        {
          id: "m1",
          threadId: "t1",
          address: "+15550100",
          body: "running late",
          date: 100,
          type: 2,
          read: true,
        },
        {
          id: "m2",
          threadId: "t1",
          address: "+15550100",
          body: "see you at noon",
          date: 200,
          type: 1,
          read: false,
        },
      ],
    },
    {
      id: "t2",
      address: "+15550200",
      unreadCount: 0,
      lastMessage: {
        id: "m3",
        threadId: "t2",
        address: "+15550200",
        body: "thanks",
        date: 150,
        type: 2,
        read: true,
      },
      messages: [
        {
          id: "m3",
          threadId: "t2",
          address: "+15550200",
          body: "thanks",
          date: 150,
          type: 2,
          read: true,
        },
      ],
    },
  ],
  selectedThreadId: "t1",
  composeAddress: "+15550100",
  composeBody: "on my way",
  ownsSmsRole: true,
  smsRoleHolder: null,
};

const view = <MessagesSpatialView snapshot={snapshot} />;

describe("MessagesSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Messages");
      expect(flat).toContain("sms-default");
      expect(flat).toContain("+15550100");
      expect(flat).toContain("see you at noon");
      expect(flat).toContain("Send");
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
      expect(html).toContain("+15550100");
      expect(html).toContain("sms-default");
      expect(html).toContain('data-agent-id="send"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("messages-test", () => view);
    try {
      const component = getTerminalView("messages-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("+15550100");
    } finally {
      unregister();
    }
  });
});

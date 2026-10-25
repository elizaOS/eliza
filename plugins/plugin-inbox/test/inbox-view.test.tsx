// @vitest-environment jsdom
/**
 * InboxView load-state tests. The spatial renderer and the UI client are
 * replaced so the test reads the snapshot InboxView hands to its renderer.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxSnapshot } from "../src/components/inbox/InboxSpatialView.tsx";
import type { InboxFetchers } from "../src/components/inbox/InboxView.tsx";

const snapshots: InboxSnapshot[] = [];

vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "" },
  dispatchChatPrefill: vi.fn(),
}));

vi.mock("../src/components/inbox/InboxSpatialView.tsx", () => ({
  InboxSpatialView: (props: { snapshot: InboxSnapshot }) => {
    snapshots.push(props.snapshot);
    return null;
  },
}));

const { InboxView } = await import("../src/components/inbox/InboxView.tsx");

type InboxWire = Awaited<ReturnType<InboxFetchers["fetchInbox"]>>;

const CHANNELS = [
  "gmail",
  "x_dm",
  "discord",
  "telegram",
  "imessage",
  "whatsapp",
  "sms",
];

function emptyWire(extra: Partial<InboxWire> = {}): InboxWire {
  return {
    messages: [],
    channelCounts: Object.fromEntries(
      CHANNELS.map((channel) => [channel, { total: 0, unread: 0 }]),
    ),
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sources: [],
    ...extra,
  } as InboxWire;
}

let container: HTMLDivElement;
let root: Root;

async function renderWith(wire: InboxWire): Promise<InboxSnapshot> {
  await act(async () => {
    root.render(<InboxView fetchers={{ fetchInbox: async () => wire }} />);
  });
  const last = snapshots.at(-1);
  if (!last) throw new Error("InboxView rendered no snapshot");
  return last;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  snapshots.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("InboxView load state", () => {
  it("shows an error, not the empty inbox, when the host reports the inbox is unavailable", async () => {
    // Shape of packages/agent/src/api/lifeops-inbox-fallback-routes.ts.
    const snapshot = await renderWith(emptyWire({ available: false }));
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("Inbox is not available on this agent.");
  });

  it("shows the empty inbox when the payload has no availability flag", async () => {
    const snapshot = await renderWith(emptyWire());
    expect(snapshot.status).toBe("empty");
    expect(snapshot.error).toBeNull();
  });

  it("shows the empty inbox when the host reports the inbox is available", async () => {
    const snapshot = await renderWith(emptyWire({ available: true }));
    expect(snapshot.status).toBe("empty");
    expect(snapshot.error).toBeNull();
  });
});

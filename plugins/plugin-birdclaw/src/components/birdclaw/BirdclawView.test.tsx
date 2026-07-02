// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BirdclawInboxItem,
  BirdclawStatusInfo,
  BirdclawTweet,
} from "../../types.ts";
import type { BirdclawFetchers } from "./BirdclawView.tsx";
import { BirdclawView } from "./BirdclawView.tsx";

const INSTALLED_STATUS: BirdclawStatusInfo = {
  installed: true,
  version: "0.8.5",
  home: "/home/user/.birdclaw",
  counts: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
  transport: {
    installed: false,
    availableTransport: "local",
    statusText: "xurl not installed. local mode active.",
  },
  message: null,
};

const TWEET: BirdclawTweet = {
  id: "t1",
  text: "Local-first sync engines beat manual export.",
  createdAt: "2026-03-08T11:18:00.000Z",
  authorHandle: "amelia",
  authorName: "Amelia N",
  likeCount: 42,
  liked: false,
  bookmarked: false,
  isReplied: null,
  kind: "home",
};

const INBOX_ITEM: BirdclawInboxItem = {
  id: "m1",
  kind: "mention",
  title: "Mention from Amelia",
  text: "curious how you decide...",
  createdAt: "2026-03-08T11:48:00.000Z",
  needsReply: true,
  score: 76,
  participantHandle: "amelia",
};

interface FetcherLog {
  tweets: Array<{ resource: string; liked?: boolean; bookmarked?: boolean }>;
  inbox: number;
  syncs: string[];
}

function fetchers(overrides: Partial<BirdclawFetchers> = {}): {
  fetchers: BirdclawFetchers;
  log: FetcherLog;
} {
  const log: FetcherLog = { tweets: [], inbox: 0, syncs: [] };
  return {
    log,
    fetchers: {
      fetchStatus: async () => INSTALLED_STATUS,
      fetchTweets: async (params) => {
        log.tweets.push(params);
        return [TWEET];
      },
      fetchInbox: async () => {
        log.inbox += 1;
        return [INBOX_ITEM];
      },
      triggerSync: async (collection) => {
        log.syncs.push(collection);
      },
      ...overrides,
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(view: BirdclawFetchers) {
  await act(async () => {
    root.render(<BirdclawView fetchers={view} />);
  });
  // Let the async load settle.
  await act(async () => {
    await Promise.resolve();
  });
}

function click(agentId: string) {
  const button = container.querySelector<HTMLElement>(
    `[data-agent-id="${agentId}"]`,
  );
  if (!button) {
    throw new Error(
      `no element with data-agent-id="${agentId}" in: ${container.innerHTML.slice(0, 400)}`,
    );
  }
  return act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe("BirdclawView", () => {
  it("loads the home timeline on mount and renders rows", async () => {
    const { fetchers: seam, log } = fetchers();
    await render(seam);
    expect(log.tweets).toEqual([{ resource: "home" }]);
    expect(container.textContent).toContain("@amelia");
    expect(container.textContent).toContain("Local-first sync engines");
  });

  it("renders the setup state when birdclaw is not installed", async () => {
    const { fetchers: seam } = fetchers({
      fetchStatus: async () => ({
        installed: false,
        version: null,
        home: null,
        counts: null,
        transport: null,
        message: "birdclaw is not installed.",
      }),
    });
    await render(seam);
    expect(container.textContent).toContain("Birdclaw is not set up yet");
    expect(container.textContent).toContain("birdclaw is not installed.");
  });

  it("renders the error state and recovers on retry", async () => {
    let fail = true;
    const { fetchers: seam } = fetchers({
      fetchTweets: async (params) => {
        if (fail) throw new Error("database is locked");
        return params.resource === "home" ? [TWEET] : [];
      },
    });
    await render(seam);
    expect(container.textContent).toContain("database is locked");
    fail = false;
    await click("retry");
    expect(container.textContent).toContain("@amelia");
  });

  it("switches tabs: likes uses the liked filter, inbox hits the inbox route", async () => {
    const { fetchers: seam, log } = fetchers();
    await render(seam);
    await click("birdclaw-tab-likes");
    expect(log.tweets.at(-1)).toEqual({
      resource: "home",
      liked: true,
      bookmarked: false,
    });
    await click("birdclaw-tab-inbox");
    expect(log.inbox).toBe(1);
    expect(container.textContent).toContain("needs reply");
  });

  it("shows the needs-reply nudge from inbox rows", async () => {
    const { fetchers: seam } = fetchers();
    await render(seam);
    await click("birdclaw-tab-inbox");
    expect(container.textContent).toContain("1 item still needs a reply.");
  });

  it("syncs the active tab's collection and reloads in place", async () => {
    const { fetchers: seam, log } = fetchers({
      fetchStatus: async () => ({
        ...INSTALLED_STATUS,
        transport: {
          installed: true,
          availableTransport: "xurl",
          statusText: "xurl ready.",
        },
      }),
    });
    await render(seam);
    await click("birdclaw-sync");
    expect(log.syncs).toEqual(["timeline"]);
    // Sync triggers a background reload of the same tab.
    expect(log.tweets.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a sync failure without dropping the list", async () => {
    const { fetchers: seam } = fetchers({
      fetchStatus: async () => ({
        ...INSTALLED_STATUS,
        transport: {
          installed: true,
          availableTransport: "xurl",
          statusText: "xurl ready.",
        },
      }),
      triggerSync: async () => {
        throw new Error("xurl not installed");
      },
    });
    await render(seam);
    await click("birdclaw-sync");
    expect(container.textContent).toContain("xurl not installed");
    expect(container.textContent).toContain("@amelia");
  });
});

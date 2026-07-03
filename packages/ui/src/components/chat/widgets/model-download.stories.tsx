import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { __setAuthStatusForTests } from "../../../hooks/useAuthStatus";
import type {
  LocalInferenceSlotReadiness,
  ModelHubSnapshot,
} from "../../../services/local-inference/types";
import {
  assert,
  WithAuthenticatedSession,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { ModelDownloadWidget } from "./model-download";

// The naked 2x1 home MODEL DOWNLOAD widget (PART A): surfaces the recommended
// local text model's download as the user lands on home — queued / downloading-%
// / loading / failed-with-retry — so a fresh on-device agent shows progress
// instead of a dead chat. Self-hides when no local model is required or every
// slot is ready.
//
// Self-contained mocking: the widget reads `client.getLocalInferenceHub()`
// (which fetches `/api/local-inference/hub` via window.fetch) and subscribes to
// the download stream. Each story installs its own fetch payload + a null
// EventSource (the on-device native-IPC fallback) so the render is deterministic
// for the story gate.

function makeSlot(
  overrides: Partial<LocalInferenceSlotReadiness>,
): LocalInferenceSlotReadiness {
  return {
    slot: "TEXT_LARGE",
    assigned: true,
    assignedModelId: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    primaryDownloaded: false,
    downloaded: false,
    active: false,
    ready: false,
    state: "downloading",
    requiredModelIds: ["eliza-1-2b"],
    missingModelIds: [],
    installedBytes: 0,
    expectedBytes: 0,
    download: {
      state: "downloading",
      receivedBytes: 0,
      totalBytes: 0,
      percent: null,
      bytesPerSec: 0,
      etaMs: null,
      updatedAt: null,
      errors: [],
    },
    errors: [],
    ...overrides,
  };
}

function makeHub(textLarge: LocalInferenceSlotReadiness): ModelHubSnapshot {
  const small = makeSlot({
    slot: "TEXT_SMALL",
    assigned: false,
    assignedModelId: null,
    displayName: null,
    state: "unassigned",
  });
  return {
    catalog: [],
    installed: [],
    active: { modelId: null, loadedAt: null, status: "idle" },
    downloads: [],
    hardware: {} as ModelHubSnapshot["hardware"],
    assignments: {} as ModelHubSnapshot["assignments"],
    textReadiness: {
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: { TEXT_SMALL: small, TEXT_LARGE: textLarge },
    },
  };
}

/** Install a window.fetch that answers the hub route with `snapshot`. */
function withHub(snapshot: ModelHubSnapshot): Decorator {
  return (Story) => {
    const originalFetch = window.fetch;
    const originalEventSource = window.EventSource;
    __setAuthStatusForTests({
      phase: "authenticated",
      identity: {
        id: "story-owner",
        displayName: "Story Owner",
        kind: "owner",
      },
      session: { id: "story-session", kind: "local", expiresAt: null },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: true,
        role: "OWNER",
      },
    });
    // On-device native-IPC fallback: no EventSource → the widget drives off the
    // single hub fetch. Undefining it keeps the story render deterministic.
    (window as { EventSource?: unknown }).EventSource = undefined;
    window.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body = url.includes("/api/local-inference/hub") ? snapshot : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof window.fetch;
    // Keep the mock installed long enough for the widget's mount fetch (and the
    // play-function assertions) to resolve against it; a queueMicrotask restore
    // races ahead of the effect's getLocalInferenceHub() call, leaving the widget
    // to hit the real (failing) fetch and self-hide. Each story renders in its
    // own iframe page, so a delayed restore cannot leak across stories.
    setTimeout(() => {
      window.fetch = originalFetch;
      (window as { EventSource?: unknown }).EventSource = originalEventSource;
      __setAuthStatusForTests({ phase: "loading" });
    }, 4_000);
    return (
      <MockAppProvider value={{ plugins: [], conversations: [] }}>
        {/* The hub fetch gates on `useIsAuthenticated()` (#11084); seed the
            authenticated session or the widget stays dormant and self-hides. */}
        <WithAuthenticatedSession>
          <div className="w-[360px] rounded-2xl bg-accent/20 p-3">
            <Story />
          </div>
        </WithAuthenticatedSession>
      </MockAppProvider>
    );
  };
}

const meta = {
  title: "Shell/Home Widgets/Model Download",
  component: ModelDownloadWidget,
  parameters: { layout: "centered" },
  args: { slot: "home", spanClassName: "col-span-2 row-span-1" },
} satisfies Meta<typeof ModelDownloadWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Downloading — the primary state: model name + percent + ETA. */
export const Downloading: Story = {
  decorators: [
    withHub(
      makeHub(
        makeSlot({
          state: "downloading",
          download: {
            state: "downloading",
            receivedBytes: 63,
            totalBytes: 100,
            percent: 63,
            bytesPerSec: 5_000_000,
            etaMs: 180_000,
            updatedAt: null,
            errors: [],
          },
        }),
      ),
    ),
  ],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-model-download",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(card.textContent?.includes("63%"), "shows the download percent");
  },
};

/** Loading — downloaded to disk, awaiting runtime activation. */
export const Loading: Story = {
  decorators: [
    withHub(
      makeHub(
        makeSlot({
          state: "downloaded",
          downloaded: true,
          primaryDownloaded: true,
        }),
      ),
    ),
  ],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-model-download",
    );
    assert(card.textContent?.includes("Loading"), "shows the loading state");
  },
};

/** Queued — assigned but not yet downloading. */
export const Queued: Story = {
  decorators: [withHub(makeHub(makeSlot({ state: "missing" })))],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-model-download",
    );
    assert(card.textContent?.includes("Queued"), "shows the queued state");
  },
};

/** Download failed — surfaces a Retry affordance (whole-card retry). */
export const DownloadFailed: Story = {
  decorators: [
    withHub(
      makeHub(
        makeSlot({
          assignedModelId: "eliza-1-4b",
          displayName: "Eliza-1 4B",
          state: "failed",
          errors: ["HuggingFace bundle not published"],
        }),
      ),
    ),
  ],
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-model-download",
    );
    assert(
      /download failed/i.test(card.getAttribute("aria-label") ?? ""),
      "the aria-label carries the failure",
    );
    assert(card.textContent?.includes("Retry"), "shows the retry badge");
  },
};

/**
 * Not required — no local text slot assigned (cloud/remote runtime). The widget
 * renders nothing; the gate asserts the card never appears.
 */
export const NotRequiredRendersNull: Story = {
  decorators: [
    withHub(
      makeHub(
        makeSlot({
          assigned: false,
          assignedModelId: null,
          displayName: null,
          state: "unassigned",
        }),
      ),
    ),
  ],
  play: async ({ canvasElement }) => {
    // Give the mount fetch a few ticks, then assert the card never rendered.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      canvasElement.querySelector(
        '[data-testid="chat-widget-model-download"]',
      ) === null,
      "self-hides when no local model is required",
    );
  },
};

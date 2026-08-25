/**
 * Storybook states for the Music Player chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { MusicPlayerSidebarWidget } from "./music-player";

/**
 * The chat-sidebar Music widget polls `GET /music-player/status` via
 * `fetchWithCsrf`. There is no backend in Storybook, so each story installs a
 * `fetch` stub for that endpoint (restored after render) to drive the widget
 * into a specific state: idle, playing, paused, or unreachable (error). Every
 * state renders visible content (the empty-state card or the now-playing row),
 * so none are blank for the story-gate.
 */
type StatusBody = {
  error?: string;
  guildId?: string;
  track?: { title?: string };
  streamUrl?: string;
  isPaused?: boolean;
};

function withStatus(body: StatusBody, ok = true): Decorator {
  return (Story) => {
    // The widget polls `/music-player/status` in an effect (after this
    // decorator returns), so the fetch stub must stay installed for the render
    // lifetime — a synchronous try/finally restore would revert it before the
    // poll runs, collapsing every story to the idle empty state. Each story
    // re-installs its own stub before rendering.
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/music-player/status")) {
        return new Response(JSON.stringify(body), {
          status: ok ? 200 : 502,
          statusText: ok ? "OK" : "Bad Gateway",
          headers: { "content-type": "application/json" },
        });
      }
      return original(input, init);
    }) as typeof fetch;
    return <Story />;
  };
}

const meta = {
  title: "Chat/Widgets/MusicPlayerWidget",
  component: MusicPlayerSidebarWidget,
  tags: ["autodocs"],
  args: { events: [], clearEvents: () => {} },
} satisfies Meta<typeof MusicPlayerSidebarWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing playing — the "No music stream is active." empty state. */
export const Idle: Story = {
  decorators: [withStatus({})],
};

/** A live stream — play/pause control, green status dot, "LIVE" label. */
export const Playing: Story = {
  decorators: [
    withStatus({
      guildId: "guild-1",
      track: { title: "Lo-fi beats to debug to" },
      streamUrl: "/music-player/stream/guild-1",
      isPaused: false,
    }),
  ],
};

/** A paused stream — amber status dot, "PAUSED" label. */
export const Paused: Story = {
  decorators: [
    withStatus({
      guildId: "guild-1",
      track: { title: "Ambient focus mix" },
      streamUrl: "/music-player/stream/guild-1",
      isPaused: true,
    }),
  ],
};

/** The player endpoint is unreachable — the error empty state. */
export const Unreachable: Story = {
  decorators: [withStatus({ error: "Music player is offline." }, false)],
};

/** A long track title must truncate without breaking the row. */
export const LongTitle: Story = {
  decorators: [
    withStatus({
      guildId: "guild-1",
      track: {
        title:
          "Deep Focus Coding Session — Extended Three Hour Continuous Mix With No Ads And No Talking Over The Music",
      },
      streamUrl: "/music-player/stream/guild-1",
      isPaused: false,
    }),
  ],
};

/** A non-ASCII track title must render without mojibake. */
export const UnicodeTitle: Story = {
  decorators: [
    withStatus({
      guildId: "guild-1",
      track: { title: "夜のドライブ 🎧 — لیلة هادئة" },
      streamUrl: "/music-player/stream/guild-1",
      isPaused: false,
    }),
  ],
};

/**
 * Renders the canonical CalendarPage through its real hook and HTTP client.
 * Isolated read fixtures show complete, partial, denied, and unavailable feeds;
 * mutations are rejected so browsing a story cannot create provider events.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CalendarPage } from "../../../../../plugins/plugin-calendar/src/components/calendar/CalendarPage";
import { MockAppProvider } from "../mock-providers";

type FeedState =
  | "empty"
  | "populated"
  | "loading"
  | "error"
  | "denied"
  | "partial";
function installFeed(state: FeedState) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.href,
    );
    if (!url.pathname.startsWith("/api/lifeops/calendar/"))
      return original(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const json = (body: object, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET")
      return json({ error: "Story fixture is read-only" }, 403);
    if (state === "loading") return new Promise<Response>(() => {});
    if (state === "error")
      return json({ error: "Calendar service is unavailable" }, 503);
    if (state === "denied")
      return json({ error: "Calendar access is denied" }, 403);
    if (url.pathname.endsWith("/calendars")) return json({ calendars: [] });
    if (url.pathname.endsWith("/sources")) return json({ sources: [] });
    const timeMin = url.searchParams.get("timeMin");
    const timeMax = url.searchParams.get("timeMax");
    if (!timeMin || !timeMax)
      return json(
        { error: "Calendar fixture requires an explicit time window" },
        400,
      );
    const start = new Date(timeMin);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start);
    end.setHours(11);
    return json({
      calendarId: "primary",
      timeMin,
      timeMax,
      source: "cache",
      syncedAt: null,
      state: state === "partial" ? "partial" : "complete",
      events:
        state === "empty"
          ? []
          : [
              {
                id: "story-event",
                externalId: "story-event",
                agentId: "story-agent",
                provider: "google",
                side: "owner",
                calendarId: "primary",
                title: "Design review",
                description: "Review the upcoming release",
                location: "",
                status: "confirmed",
                startAt: start.toISOString(),
                endAt: end.toISOString(),
                isAllDay: false,
                timezone: null,
                htmlLink: null,
                conferenceLink: null,
                organizer: null,
                attendees: [],
                metadata: {},
                syncedAt: start.toISOString(),
                updatedAt: start.toISOString(),
                calendarSummary: "Primary",
              },
            ],
      sources: [
        {
          key: {
            provider: "google",
            side: "owner",
            grantId: "story-grant",
            connectorAccountId: "story-account",
            calendarId: "primary",
          },
          summary: "Primary",
          accessRole: "reader",
          visibility: "details",
          status: state === "partial" ? "error" : "fresh",
          syncedAt: start.toISOString(),
          error:
            state === "partial"
              ? {
                  code: "sync_failed",
                  message: "Source refresh failed",
                  retryable: true,
                }
              : null,
        },
      ],
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
const meta = {
  title: "Plugin views/Calendar",
  component: CalendarPage,
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div style={{ height: "100vh" }}>
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CalendarPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { beforeEach: () => installFeed("empty") };
export const Populated: Story = { beforeEach: () => installFeed("populated") };
export const Loading: Story = { beforeEach: () => installFeed("loading") };
export const LoadError: Story = { beforeEach: () => installFeed("error") };
export const Denied: Story = { beforeEach: () => installFeed("denied") };
export const PartialSource: Story = {
  beforeEach: () => installFeed("partial"),
};

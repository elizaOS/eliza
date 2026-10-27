import { describe, expect, it } from "vitest";
import {
  createOverviewFormat,
  type OverviewAgendaCandidate,
  overviewAgendaEmptyTitle,
  overviewAgendaHeader,
  overviewAttendeeInitials,
  overviewBriefOutcome,
  overviewCalendarName,
  overviewCalendarState,
  overviewOverdueDueLabel,
  overviewReadIsStale,
  presentOverviewAgendaNext,
  presentOverviewAgendaSource,
  presentOverviewAttention,
  presentOverviewBrief,
  presentOverviewBriefCard,
  presentOverviewCalendar,
  presentOverviewInboxStatus,
  presentOverviewWorkflowFreshness,
  selectOverviewAgenda,
} from "../daily-overview";

// The suite runs with TZ=UTC; local constructors keep the fixtures readable.
const f = createOverviewFormat({ locale: "en-US" });
const now = new Date(2026, 9, 7, 15, 30).getTime();
const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m).getTime();

describe("attention", () => {
  it("offers setup when no mail source is connected", () => {
    for (const summary of [null, undefined, { state: "not-connected" as const }, { state: "ready" as const }]) {
      const card = presentOverviewAttention(summary, now, f);
      expect(card.action).toBe("connections");
      expect(card.text).toBe("Set up Gmail");
    }
  });
  it("loading, ready, stale and error are explicit and open the mailbox", () => {
    expect(presentOverviewAttention({ state: "loading", source: "Gmail" }, now, f)).toEqual({
      action: "inbox",
      count: "…",
      text: "Checking Gmail…",
      label: "Open Inbox: checking Gmail",
    });
    expect(presentOverviewAttention({ state: "ready", unread: 3, source: "Gmail", updatedAt: at(15, 4) }, now, f)).toEqual({
      action: "inbox",
      count: "3",
      text: "unread · Gmail · 3:04 PM",
      label: "Open Inbox: 3 unread emails",
    });
    expect(presentOverviewAttention({ state: "ready", unread: 0, source: "Gmail", updatedAt: new Date(at(9)).toISOString() }, now, f).text).toBe(
      "Nothing unread · Gmail · 9:00 AM",
    );
    const stale = presentOverviewAttention({ state: "stale", unread: 2, source: "Gmail", updatedAt: at(8, 15, 6) }, now, f);
    expect([stale.count, stale.text]).toEqual(["2", "Not updated since Tue, Oct 6 8:15 AM"]);
    expect(stale.label).toBe("Open Inbox: Gmail has not updated since Tue, Oct 6 8:15 AM; 2 unread emails when last read");
    expect(presentOverviewAttention({ state: "error", message: "Gmail authorization expired" }, now, f)).toEqual({
      action: "inbox",
      count: "!",
      text: "Gmail authorization expired",
      label: "Open Inbox to retry: Gmail authorization expired",
    });
    expect(presentOverviewAttention({ state: "error" }, now, f).text).toBe("Inbox could not be checked");
  });
  it("a stale mailbox that was never read claims no count", () => {
    for (const unread of [0, undefined]) {
      const card = presentOverviewAttention({ state: "stale", unread, source: "Gmail", updatedAt: null }, now, f);
      expect([card.count, card.text, card.label]).toEqual(["—", "Not updated recently", "Open Inbox: Gmail has not updated"]);
    }
  });
  it("inbox status line names only loaded metadata", () => {
    const base = { failure: false, pending: false, cached: null, connected: false, unchecked: false, now };
    expect(presentOverviewInboxStatus({ ...base, cached: { more: false, label: "work@example.test", readAt: at(15, 4) } }, f)).toBe(
      "work@example.test · Updated 3:04 PM",
    );
    expect(presentOverviewInboxStatus({ ...base, cached: { more: true, label: "w", readAt: at(8, 15, 6) } }, f)).toBe(
      "Recent email · Updated Tue, Oct 6 8:15 AM",
    );
    expect(presentOverviewInboxStatus({ ...base, failure: true, cached: { more: false, label: "a", readAt: at(15, 4) } }, f)).toBe(
      "Open to retry · last updated 3:04 PM",
    );
    expect(presentOverviewInboxStatus({ ...base, pending: true }, f)).toBe("Updating email…");
    expect(presentOverviewInboxStatus({ ...base, connected: true }, f)).toBe("Open to load email");
    expect(presentOverviewInboxStatus({ ...base, unchecked: true }, f)).toBe("Open to check email");
    expect(presentOverviewInboxStatus(base, f)).toBe("");
  });
});

describe("brief", () => {
  it("no placeholder brief without a retained result", () => {
    expect(presentOverviewBrief(null, now, f).has).toBe(false);
    expect(presentOverviewBriefCard(null, now, f)).toEqual({ has: false, title: "", status: "", failed: false, label: "" });
    expect(presentOverviewBriefCard({ summary: "  ", ranAt: at(7), agent: "A", status: "finished" }, now, f).has).toBe(false);
    expect(presentOverviewBriefCard({ summary: "Ready", ranAt: "never", agent: "A", status: "finished" }, now, f).has).toBe(false);
  });
  it("names the agent and run time, and a failure", () => {
    const card = presentOverviewBriefCard({ summary: "Two meetings\ntoday.", ranAt: new Date(at(7, 2)).toISOString(), agent: "Alpha", status: "finished" }, now, f);
    expect(card).toEqual({
      has: true,
      title: "Two meetings today.",
      failed: false,
      status: "Alpha · Ran 7:02 AM",
      label: "Open scheduled digests. Latest brief from Alpha, ran 7:02 AM: Two meetings today.",
    });
    const failed = presentOverviewBriefCard({ summary: `Source expired. ${"x".repeat(200)}`, ranAt: at(22, 30, 6), agent: "", status: "failed" }, now, f);
    expect([failed.failed, failed.status]).toEqual([true, "Your agent · Failed Tue, Oct 6 10:30 PM"]);
    expect(failed.title.length <= 96 && failed.title.endsWith("…")).toBe(true);
  });
  it("a record of an occurrence that did not run is never presented as a run", () => {
    for (const status of ["missed", "overlap", "unavailable"]) {
      expect(overviewBriefOutcome(status)).toBe("not-run");
      expect(presentOverviewBriefCard({ summary: "x", ranAt: at(8), agent: "A", status }, now, f).status).toBe("A · Did not run 8:00 AM");
    }
    expect(["finished", "succeeded", "", undefined].map(overviewBriefOutcome)).toEqual(["ran", "ran", "ran", "ran"]);
    expect(["failed", "cancelled", "error"].map(overviewBriefOutcome)).toEqual(["failed", "failed", "failed"]);
  });
});

describe("agenda", () => {
  it("maps calendar adapter status to card states", () => {
    expect(overviewCalendarState("Calendar access denied")).toBe("denied");
    expect(overviewCalendarState("Calendar range could not be loaded.")).toBe("error");
    expect(overviewCalendarState("Loading calendars…")).toBe("loading");
    expect(overviewCalendarState("Device calendars connected")).toBe("ready");
    expect(overviewCalendarState("Device calendars are available in the Android app.")).toBe("unavailable");
    expect(overviewCalendarState(undefined)).toBe("not-connected");
  });
  it("empty titles for loading, empty, limited, hidden, error, access off and not connected", () => {
    expect(overviewAgendaEmptyTitle(null)).toBe("Loading events…");
    expect(overviewAgendaEmptyTitle({ ready: true })).toBe("No upcoming events");
    expect(overviewAgendaEmptyTitle({ ready: true, truncated: true })).toBe("Results limited");
    expect(overviewAgendaEmptyTitle({ ready: true }, true)).toBe("No visible events");
    expect(overviewAgendaEmptyTitle({ error: true, status: "Calendar access denied" })).toBe("Calendar unavailable");
    expect(overviewAgendaEmptyTitle({ native: true, status: "Calendar access denied" })).toBe("Calendar access is off");
    expect(overviewAgendaEmptyTitle({ native: true, status: "Not connected" })).toBe("Connect your calendar");
    expect(overviewAgendaEmptyTitle({ native: false, status: "Connect device calendars" })).toBe("Calendar unavailable");
  });
  it("source and freshness of the shown item", () => {
    const base = { overdue: false, readAt: at(15, 4), now, native: true };
    expect(presentOverviewAgendaSource({ ...base, state: "ready", calendar: "Work" }, f)).toEqual({
      origin: "Work",
      read: "",
      description: "Work. Read 3:04 PM from calendars on this device",
    });
    expect(presentOverviewAgendaSource({ ...base, state: "error" }, f).read).toBe("Open Calendar to retry");
    expect(presentOverviewAgendaSource({ ...base, state: "loading" }, f)).toEqual({ origin: "", read: "", description: "" });
    expect(presentOverviewAgendaSource({ ...base, state: "ready", reminder: true, reminderReadAt: at(14, 50) }, f)).toEqual({
      origin: "Reminder",
      read: "",
      description: "Reminder saved on this device, read 2:50 PM",
    });
    expect(presentOverviewAgendaSource({ ...base, state: "error", overdue: true }, f).description).toBe("Overdue reminder saved on this device");
  });
  it("a read from an earlier day is stale and says so", () => {
    expect(overviewReadIsStale(at(23, 59, 6), now)).toBe(true);
    expect(overviewReadIsStale(at(0, 0, 7), now)).toBe(false);
    expect(overviewReadIsStale(null, now)).toBe(false);
    expect(overviewReadIsStale(at(9, 0, 8), now)).toBe(false);
    const stale = presentOverviewAgendaSource({ state: "stale", overdue: false, readAt: at(21, 5, 6), now, native: true, calendar: "Work" }, f);
    expect(stale).toEqual({
      origin: "",
      read: "Not updated since Tue, Oct 6 9:05 PM",
      description: "Calendar not updated since Tue, Oct 6 9:05 PM; today's changes may be missing. Open Calendar to refresh.",
    });
    // An overdue reminder keeps the reminder store's own provenance.
    expect(presentOverviewAgendaSource({ state: "stale", overdue: true, readAt: at(21, 5, 6), now, native: false }, f).description).toBe(
      "Overdue reminder saved on this browser",
    );
  });
  it("an overdue reminder comes first and the next item keeps its own line", () => {
    const candidates: OverviewAgendaCandidate<string>[] = [
      { item: "ended", begin: at(9), end: at(10), allDay: false },
      { item: "in-progress", begin: at(15), end: at(16), allDay: false },
      { item: "later", begin: at(17), end: at(18), allDay: false },
      { item: "overdue-1", begin: at(9), end: Number.POSITIVE_INFINITY, allDay: false, overdue: true },
      { item: "overdue-2", begin: at(11), end: Number.POSITIVE_INFINITY, allDay: false, overdue: true },
      { item: "all-day-yesterday", begin: at(0, 0, 6), end: at(0, 0, 7), allDay: true },
      { item: "invalid", begin: Number.NaN, end: at(18), allDay: false },
    ];
    const selection = selectOverviewAgenda(candidates, now);
    expect(selection.agenda?.item).toBe("overdue-1");
    expect(selection.following?.item).toBe("in-progress");
    expect(selection.overdue).toBe(2);
    const plain = selectOverviewAgenda(candidates.filter((c) => !c.overdue), now);
    expect([plain.agenda?.item, plain.following, plain.overdue]).toEqual(["in-progress", null, 0]);
    expect(selectOverviewAgenda([], now)).toEqual({ agenda: null, following: null, overdue: 0 });
    const provenance = presentOverviewAgendaSource({ state: "ready", overdue: false, readAt: at(15, 4), now, native: true, calendar: "Work" }, f);
    expect(presentOverviewAgendaNext({ title: "Design review", begin: at(16), allDay: false, now, provenance }, f)).toEqual({
      text: "Next: Design review 4:00 PM",
      source: "Work",
      description: "Next: Design review, 4:00 PM. Work. Read 3:04 PM from calendars on this device",
    });
    expect(presentOverviewAgendaNext({ title: " ", begin: at(15), allDay: false, now, provenance }, f).text).toBe("Next: Untitled event Now");
    expect(overviewAgendaHeader("Wed, Oct 7", 0)).toBe("Wed, Oct 7");
    expect(overviewAgendaHeader("Wed, Oct 7", 1)).toBe("Overdue reminder");
    expect(overviewAgendaHeader("Wed, Oct 7", 3)).toBe("3 overdue reminders");
    expect(overviewOverdueDueLabel(at(9, 0, 5), now, f)).toBe("Due Mon, Oct 5 9:00 AM");
  });
  it("calendar names come only from the same read, matched exactly", () => {
    const sources = [{ id: "7", name: "Harbour team" }, { id: "8", name: "  Family  " }, { id: "9", name: "" }, null];
    expect(overviewCalendarName(sources, "7")).toBe("Harbour team");
    expect(overviewCalendarName(sources, "8")).toBe("Family");
    expect(overviewCalendarName(sources, "70")).toBeNull();
    expect(overviewCalendarName(sources, "9")).toBeNull();
    expect(overviewCalendarName(sources, 7)).toBeNull();
    expect(overviewCalendarName(undefined, "7")).toBeNull();
  });
  it("card copy for every state, with a stable accessible name", () => {
    const base = { agenda: null, readAt: at(15, 4), now, device: "this device" };
    expect(presentOverviewCalendar({ ...base, state: "denied" }, f).title).toBe("Calendar access is off");
    expect(presentOverviewCalendar({ ...base, state: "error" }, f).time).toBe("Tap to retry");
    expect(presentOverviewCalendar({ ...base, state: "ready" }, f).source).toBe("Read 3:04 PM from this device");
    for (const state of ["denied", "error", "loading", "ready", "unavailable", "not-connected"] as const)
      expect(presentOverviewCalendar({ ...base, state }, f).label).toBe("Open your calendar");
    expect(
      presentOverviewCalendar({ ...base, state: "ready", agenda: { title: "Trip", begin: at(0, 0, 9), allDay: true, video: true, people: [] } }, f).time,
    ).toBe("Fri, Oct 9");
    expect(overviewAttendeeInitials(["Ada Lovelace", "grace hopper", 42, ""])).toEqual(["AL", "GH"]);
    expect(overviewAttendeeInitials(["A B", "C D", "E F", "G H"])).toEqual(["AB", "CD", "+2"]);
  });
});

describe("workflow freshness", () => {
  it("only after a list was actually loaded", () => {
    expect(presentOverviewWorkflowFreshness({ loadedAt: null, now, unified: true }, f)).toEqual({ visible: "", description: "" });
    expect(presentOverviewWorkflowFreshness({ loadedAt: at(15, 4), now, unified: true, agent: false }, f)).toEqual({
      visible: "Loaded 3:04 PM",
      description: "Reminders on this phone, loaded 3:04 PM",
    });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createOverviewFormat,
  presentOverviewAgendaSource,
  presentOverviewAttention,
  presentOverviewBriefCard,
} from "../daily-overview";
import {
  OverviewAgendaCard,
  OverviewAttentionCard,
  OverviewBriefCard,
} from "../OverviewCards";

const f = createOverviewFormat({ locale: "en-US" });
const now = new Date(2026, 9, 7, 15, 30).getTime();
const at = (h: number, m = 0, day = 7) => new Date(2026, 9, day, h, m).getTime();
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("OverviewAgendaCard", () => {
  const base = {
    heading: "Wed, Oct 7",
    origin: "",
    footer: "",
    hasItem: false,
    source: "",
    overdue: false,
    label: "Open your calendar",
  };
  it("loading and empty states render only the title, with no fixture text", () => {
    for (const title of ["Loading events…", "No upcoming events", "Calendar access is off", "Connect your calendar"]) {
      const markup = html(<OverviewAgendaCard {...base} title={title} />);
      expect(markup).toContain(`>${title}<`);
      expect(markup).toContain('data-overview-state="empty"');
      expect(markup).toContain('data-overview-has-meta="false"');
      expect(markup).not.toContain('data-overview-part="meta"');
      expect(markup).not.toContain('data-overview-part="next"');
    }
  });
  it("an error keeps the retry line and the accessible description", () => {
    const provenance = presentOverviewAgendaSource({ state: "error", overdue: false, readAt: at(15, 4), now, native: true }, f);
    const markup = html(
      <OverviewAgendaCard {...base} title="Calendar unavailable" source={provenance.read} description={provenance.description} />,
    );
    expect(markup).toContain('data-overview-part="source">Open Calendar to retry<');
    expect(markup).toContain('aria-description="Calendar could not be read. Open Calendar to retry."');
    expect(markup).toContain('data-overview-has-meta="true"');
  });
  it("a stale read is marked and names its time", () => {
    const provenance = presentOverviewAgendaSource({ state: "stale", overdue: false, readAt: at(21, 5, 6), now, native: true }, f);
    const markup = html(
      <OverviewAgendaCard {...base} hasItem title="Standup" footer="4:00 PM" source={provenance.read} description={provenance.description} stale />,
    );
    expect(markup).toContain('data-overview-state="stale"');
    expect(markup).toContain(">Not updated since Tue, Oct 6 9:05 PM<");
  });
  it("an overdue reminder shows the next item on its own line, with host classes and attributes", () => {
    const markup = html(
      <OverviewAgendaCard
        {...base}
        heading="Overdue reminder"
        hasItem
        overdue
        title="Pay rent"
        footer="Due 9:00 AM"
        next={{ text: "Next: Design review 4:00 PM", source: "Work" }}
        classNames={{ card: "host-card", title: "host-title" }}
        dataAttributes={{ "data-host-card": "" }}
        partAttributes={{ next: { "data-host-next": "" } }}
        onActivate={() => {}}
      />,
    );
    expect(markup).toMatch(/^<button type="button" data-overview-part="card" class="host-card"/);
    expect(markup).toContain('data-overview-state="overdue"');
    expect(markup).toContain('data-overview-overdue="true"');
    expect(markup).toContain('data-overview-has-next="true"');
    expect(markup).toContain('data-host-card=""');
    expect(markup).toContain('class="host-title">Pay rent<');
    expect(markup).toContain('data-host-next=""');
    expect(markup).toContain(">Next: Design review 4:00 PM<");
    expect(markup).toContain('data-overview-part="nextSource">Work<');
  });
});

describe("OverviewAttentionCard", () => {
  it("renders presenter states without message bodies", () => {
    const states = [
      presentOverviewAttention(null, now, f),
      presentOverviewAttention({ state: "loading", source: "Gmail" }, now, f),
      presentOverviewAttention({ state: "ready", unread: 2, source: "Gmail", updatedAt: at(15, 4) }, now, f),
      presentOverviewAttention({ state: "stale", unread: 2, source: "Gmail", updatedAt: at(8, 15, 6) }, now, f),
      presentOverviewAttention({ state: "error", message: "Reconnect Gmail" }, now, f),
    ];
    for (const card of states) {
      const markup = html(<OverviewAttentionCard count={card.count} title="" status={card.text} label={card.label} />);
      expect(markup).toContain(`aria-label="${card.label}"`);
      expect(markup).toContain(`data-overview-part="count">${card.count}<`);
      expect(markup).not.toContain('data-overview-part="rows"');
    }
    const rows = html(
      <OverviewAttentionCard
        count="2 unread"
        title=""
        status="work@example.test · Updated 3:04 PM"
        label="Open Inbox: 2 unread emails"
        rows={[{ title: "Invoice", detail: "Billing" }]}
        state="ready"
      />,
    );
    expect(rows).toContain('data-overview-part="rowTitle">Invoice<');
    expect(rows).toContain('data-overview-state="ready"');
  });
});

describe("OverviewBriefCard", () => {
  it("renders the retained brief and its failure state", () => {
    const brief = presentOverviewBriefCard({ summary: "Two meetings today.", ranAt: at(7, 2), agent: "Alpha", status: "finished" }, now, f);
    if (!brief.has) throw new Error("expected a brief");
    const markup = html(<OverviewBriefCard title={brief.title} status={brief.status} failed={brief.failed} label={brief.label} />);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('data-overview-failed="false"');
    expect(markup).toContain('data-overview-part="heading">Latest brief<');
    expect(markup).toContain(">Alpha · Ran 7:02 AM<");
    const failed = presentOverviewBriefCard({ summary: "Source expired", ranAt: at(7), agent: "Alpha", status: "failed" }, now, f);
    if (!failed.has) throw new Error("expected a failed brief");
    expect(html(<OverviewBriefCard title={failed.title} status={failed.status} failed={failed.failed} label={failed.label} />)).toContain(
      'data-overview-state="failed"',
    );
  });
});

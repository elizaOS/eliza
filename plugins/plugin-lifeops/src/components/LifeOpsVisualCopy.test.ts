import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readComponent(name: string): string {
  return readFileSync(resolve(here, name), "utf8");
}

function readCalendarComponent(name: string): string {
  return readFileSync(
    resolve(here, "../../../plugin-calendar/src/components", name),
    "utf8",
  );
}

describe("LifeOps visual copy", () => {
  it("keeps LifeOps app metadata focused on personal assistant ownership", () => {
    const pluginSource = readFileSync(resolve(here, "../plugin.ts"), "utf8");
    const uiSource = readFileSync(resolve(here, "../ui.ts"), "utf8");
    const metadataSource = `${pluginSource}\n${uiSource}`;

    expect(metadataSource).toContain("Personal assistant workspace");
    expect(metadataSource).toContain('"assistant"');
    expect(metadataSource).not.toContain('"health"');
    expect(metadataSource).not.toContain("and health");
    expect(metadataSource).not.toContain("screen-time");
    expect(metadataSource).not.toContain("screen time");
  });

  it("keeps money section empty states compact and separator text plain", () => {
    const source = readComponent("LifeOpsMoneySection.tsx");
    const plaid = readComponent("LifeOpsLinkBankButton.tsx");
    const paypal = readComponent("LifeOpsLinkPaypalButton.tsx");

    expect(source).not.toContain('<p className="text-xs text-muted"');
    expect(source).toContain("MoneyStatusIcon");
    expect(source).not.toContain("Loading money dashboard…");
    expect(source).not.toContain("No sources.");
    expect(source).not.toContain("No categories.");
    expect(source).not.toContain("No bills from email.");
    expect(source).not.toContain("No recurring charges.");
    expect(source).not.toContain("Loading…");
    expect(source).not.toContain(">Settings<");
    expect(source).not.toContain("Refreshing…");
    expect(source).not.toContain("Importing CSV into");
    expect(source).not.toContain("Syncing ${source.label} via Plaid…");
    expect(source).not.toContain("Syncing ${source.label} via PayPal…");
    expect(source).not.toContain("text-xs text-emerald-300");
    expect(source).toContain("CSV import active");
    expect(source).toContain("Plaid sync active");
    expect(source).toContain("PayPal sync active");
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("×");
    for (const paymentSource of [plaid, paypal]) {
      expect(paymentSource).not.toContain("Linking…");
      expect(paymentSource).not.toContain(" → ");
    }
    expect(plaid).not.toContain("Preparing Plaid…");
    expect(paypal).not.toContain("Preparing PayPal…");
    expect(paypal).not.toContain("Waiting for PayPal…");
  });

  it("keeps messaging connector copy free of raw arrow or dot separators", () => {
    const messaging = readComponent("MessagingConnectorCards.tsx");

    expect(messaging).not.toContain(" → ");
    expect(messaging).not.toContain(" • ");
  });

  it("keeps messaging connector diagnostics icon-led instead of prose panels", () => {
    const messaging = readComponent("MessagingConnectorCards.tsx");

    expect(messaging).toContain("ConnectorPipSummary");
    expect(messaging).not.toContain("<details");
    expect(messaging).not.toContain("<summary");
    expect(messaging).not.toContain("Phone number ID:");
    expect(messaging).not.toContain("Control on");
    expect(messaging).not.toContain("Control off");
    expect(messaging).not.toContain("Inbound:");
    expect(messaging).not.toContain("Outbound:");
    expect(messaging).not.toContain("Runtime:");
    expect(messaging).not.toContain(
      "Eliza can send through Messages.app now.",
    );
    expect(messaging).not.toContain(
      "Full Disk Access is still blocked for the process running Eliza",
    );
    expect(messaging).not.toContain(
      "iMessage bridging requires a Mac host running Messages.app.",
    );
  });

  it("keeps reminder controls from reintroducing paragraph helper copy", () => {
    const source = readComponent("LifeOpsRemindersSection.tsx");

    expect(source).not.toContain("<p className=");
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).toContain("ReminderStatusIcon");
    expect(source).not.toContain("Loading reminders…");
    expect(source).not.toContain("Loading alarms…");
    expect(source).not.toContain("Custom…");
    expect(source).not.toContain("No alarms yet.");
    expect(source).not.toContain("Clock-time LifeOps alerts.");
  });

  it("keeps calendar status states icon-led and separator text plain", () => {
    const source = readCalendarComponent("CalendarSection.tsx");

    expect(source).toContain("CalendarStatusIcon");
    expect(source).not.toContain("Loading events…");
    expect(source).not.toContain("Nothing scheduled.");
    expect(source).not.toContain(" · ");
  });

  it("keeps event editor commands and calendar labels icon-led", () => {
    const source = readCalendarComponent("EventEditorDrawer.tsx");

    expect(source).toContain("MessageSquare");
    expect(source).toContain("Trash2");
    expect(source).toContain("Save");
    expect(source).toContain("sr-only");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("Creating…");
    expect(source).not.toContain("Saving…");
    expect(source).not.toContain("Loading…");
    expect(source).not.toContain("Add notes…");
    expect(source).not.toContain("Save & continue");
  });

  it("keeps workspace calendar states compact and free of raw separators", () => {
    const source = readComponent("LifeOpsWorkspaceView.tsx");

    expect(source).toContain("WorkspaceStatusIcon");
    expect(source).not.toContain("Grant calendar access for this Google account in Setup.");
    expect(source).not.toContain("Grant Gmail access for this Google account in Setup.");
    expect(source).not.toContain("No Gmail recommendations for this query.");
    expect(source).not.toContain("Loading recent mail…");
    expect(source).not.toContain("Inbox clear. Nothing to triage right now.");
    expect(source).not.toContain("Drafting...");
    expect(source).not.toContain("Sending...");
    expect(source).not.toContain(
      "Connect Google for both User and Agent in Setup above to see today's events and create new ones here.",
    );
    expect(source).not.toContain(
      "Connect Google for both User and Agent in Setup above to triage replies and draft responses here.",
    );
    expect(source).toContain("Gmail locked");
    expect(source).toContain("Recommendations clear");
    expect(source).toContain("Reading mail");
    expect(source).not.toContain("Loading events…");
    expect(source).not.toContain(
      "Nothing scheduled. Use New event below to add one.",
    );
    expect(source).not.toContain("Creating…");
    expect(source).not.toContain(" · ");
  });

  it("keeps first-run setup gate compact and status-led", () => {
    const source = readComponent("LifeOpsSetupGate.tsx");

    expect(source).toContain("SetupStatusPip");
    expect(source).not.toContain("<p className=");
    expect(source).not.toContain("lifeopssetup.description");
    expect(source).not.toContain("lifeopssetup.connectProvider");
    expect(source).not.toContain("lifeopssetup.calendarHint");
    expect(source).not.toContain("lifeopssetup.messagingHint");
    expect(source).not.toContain("Read events, manage your schedule");
    expect(source).not.toContain("Read and reply to incoming DMs");
    expect(source).not.toContain("Skip for now<");
    expect(source).not.toContain("Continue<");
  });

  it("keeps feature toggles compact and metadata-led", () => {
    const source = readComponent("LifeOpsFeatureTogglesSection.tsx");

    expect(source).not.toContain("<p className=");
    expect(source).not.toContain(">Sign in<");
    expect(source).not.toContain(">Sync<");
    expect(source).not.toContain(">Syncing<");
    expect(source).not.toContain("Cloud sign-in enables managed billing; local toggle uses\n");
  });

  it("keeps device setup compact and health-owned", () => {
    const source = readComponent("MobileSignalsSetupCard.tsx");

    expect(source).toContain(
      'from "@elizaos/plugin-health/screen-time/mobile-signal-setup"',
    );
    expect(source).toContain("DeviceSetupMessagePip");
    expect(source).toContain("DeviceActionStatusPip");
    expect(source).not.toContain("<p className=");
    expect(source).toContain('<span className="sr-only">{label}</span>');
    expect(source).not.toContain("{message ? <p");
  });

  it("keeps app blocker empty states compact", () => {
    const source = readComponent("AppBlockerSettingsCard.tsx");

    expect(source).toContain("AppBlockerStatusIcon");
    expect(source).toContain("Apps clear");
    expect(source).toContain("Selection clear");
    expect(source).toContain("sr-only");
    expect(source).not.toContain("No installed apps matched that search.");
    expect(source).not.toContain("No iPhone apps selected yet.");
  });

  it("keeps documents controls compact and icon-led", () => {
    const source = readComponent("LifeOpsDocumentsSection.tsx");

    expect(source).not.toContain("Loading documents...");
    expect(source).not.toContain(
      'No owner-private documents yet. Use "New note" to add one.',
    );
    expect(source).not.toContain("Deleting...");
    expect(source).not.toContain("Saving...");
  });

  it("keeps overview assistant-first and free of dashboard loading copy", () => {
    const source = readComponent("LifeOpsOverviewSection.tsx");

    expect(source).toContain("LifeOpsOverviewAssistantDock");
    expect(source).toContain("lifeops-overview-assistant-dock");
    expect(source).toContain("lifeops-overview-signals");
    expect(source).toContain("OverviewStatusIcon");
    expect(source).not.toContain("getLifeOpsScreenTimeSummary");
    expect(source).not.toContain('label="Sleep"');
    expect(source).not.toContain('label="Screen"');
    expect(source).not.toContain('label="sleep"');
    expect(source).not.toContain('label="screen"');
    expect(source).not.toContain('title="Sleep"');
    expect(source).not.toContain('title="Screen Time"');
    expect(source).not.toContain('title="Social"');
    expect(source).not.toContain("Loading dashboard");
    expect(source).not.toContain("Reading screen time");
    expect(source).not.toContain("Reading calendar...");
    expect(source).not.toContain("Reading messages...");
    expect(source).not.toContain("Reading mail...");
    expect(source).toContain('<span className="sr-only">Open setup</span>');
    expect(source).toContain('<span className="sr-only">Open Settings</span>');
    expect(source).toContain('<span className="sr-only">Connect a source</span>');
    expect(source).not.toContain('<h2 className="mt-4');
    expect(source).not.toContain('<span className="text-xs text-muted">No live messages.</span>');
    expect(source).not.toContain("Nothing scheduled.");
    expect(source).not.toContain("No priority messages.");
    expect(source).not.toContain("No priority mail.");
    expect(source).not.toContain("No active reminders.");
    expect(source).toContain("<EmptyState>Schedule clear</EmptyState>");
    expect(source).toContain("<EmptyState>Messages clear</EmptyState>");
    expect(source).toContain("<EmptyState>Mail clear</EmptyState>");
    expect(source).toContain("<EmptyState>Reminders clear</EmptyState>");
    expect(source).not.toContain("Weekly comparison unavailable");
  });

  it("keeps missing source CTA icon-only", () => {
    const source = readComponent("MissingSourceCard.tsx");

    expect(source).toContain("PlugZap");
    expect(source).toContain("sr-only");
    expect(source).not.toContain("<ArrowRight");
    expect(source).not.toContain("<span>{ctaLabel}</span>");
  });

  it("keeps inbox status and workflow copy compact", () => {
    const source = readComponent("LifeOpsInboxSection.tsx");

    expect(source).toContain("InboxStatusIcon");
    expect(source).not.toContain("Loading...");
    expect(source).not.toContain("Loading inbox…");
    expect(source).not.toContain("No matches.");
    expect(source).not.toContain("Inbox clear.");
    expect(source).not.toContain("Missed ·");
    expect(source).not.toContain("Unsubscribing…");
    expect(source).not.toContain("Search…");
    expect(source).not.toContain("Gmail ·");
    expect(source).not.toContain("<p className=");
  });

  it("keeps section-level inbox empty labels status-like", () => {
    const source = readComponent("LifeOpsSectionContent.tsx");

    expect(source).toContain('emptyLabel="Messages clear"');
    expect(source).toContain('emptyLabel="Mail clear"');
    expect(source).not.toContain('emptyLabel="No messages."');
    expect(source).not.toContain('emptyLabel="No mail."');
  });

  it("keeps legacy page-section lists compact", () => {
    const source = readComponent("LifeOpsPageSections.tsx");

    expect(source).toContain("CompactEmptyState");
    expect(source).toContain('label="Items clear"');
    expect(source).toContain('label="Goals clear"');
    expect(source).toContain('label="Reminders clear"');
    expect(source).toContain("sr-only");
    expect(source).not.toContain("No active items.");
    expect(source).not.toContain("No active goals.");
    expect(source).not.toContain("No goal detail yet.");
    expect(source).not.toContain("No live reminders.");
  });

  it("keeps operational connector handoffs icon-only", () => {
    const source = readComponent("LifeOpsOperationalPanels.tsx");

    expect(source).toContain("Open plugin-x connector setup");
    expect(source).toContain("sr-only");
    expect(source).not.toContain('<Settings className="mr-1.5 h-3.5 w-3.5" />');
    expect(source).not.toContain('className="h-8 rounded-xl px-3');
  });

  it("keeps chat LifeOps overview rows compact", () => {
    const source = readComponent(
      "chat/widgets/plugins/lifeops-overview.tsx",
    );

    expect(source).toContain("sr-only");
    expect(source).not.toContain("<p className=");
    expect(source).not.toContain('join(" • ")');
    expect(source).not.toContain(" • ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("Refreshing life ops…");
    expect(source).not.toContain("No life ops yet");
  });

  it("keeps chat adapter selection affordance icon-only", () => {
    const source = readComponent("LifeOpsChatAdapter.tsx");

    expect(source).toContain("MessageCircle");
    expect(source).toContain("sr-only");
    expect(source).toContain("Reminder selected");
    expect(source).toContain("Event selected");
    expect(source).toContain("Message selected");
    expect(source).not.toContain("Ask about this reminder…");
    expect(source).not.toContain("Ask about this event…");
    expect(source).not.toContain("Ask about this message…");
    expect(source).not.toContain(" — ");
  });

  it("keeps settings redirects compact and ownership-copy-free", () => {
    const source = readComponent("LifeOpsSettingsSection.tsx");

    expect(source).toContain("HealthConnectorRedirectCard");
    expect(source).toContain("BrowserBridgeRedirectCard");
    expect(source).toContain('StatusDot label="plugin-health owns setup"');
    expect(source).toContain('StatusDot label="plugin-browser owns setup"');
    expect(source).not.toContain("lifeopssettings.healthConnectorOwner");
    expect(source).not.toContain("lifeopssettings.browserBridgeOwner");
    expect(source).not.toContain("lifeopssettings.smartFeaturesDescription");
    expect(source).not.toContain("lifeopssettings.priorityScoringModelHelp");
    expect(source).not.toContain("lifeopssettings.emailIntelligenceDescription");
    expect(source).not.toContain("lifeopssettings.emailClassifierModelHelp");
    expect(source).not.toContain("<p className=");
    expect(source).not.toContain('defaultValue: "plugin-health owns setup"');
    expect(source).not.toContain('defaultValue: "plugin-browser owns setup"');
    expect(source).not.toContain('defaultValue: "Setup"');
    expect(source).not.toContain("Loading calendars…");
    expect(source).not.toContain("No readable calendars found.");
    expect(source).toContain("Reading calendars");
    expect(source).toContain("Calendars clear");
  });

  it("keeps desktop navigation compact and active-label only", () => {
    const shell = readComponent("LifeOpsWorkspaceShell.tsx");
    const nav = readComponent("LifeOpsNavRail.tsx");
    const page = readComponent("LifeOpsPageView.tsx");

    expect(shell).toContain('labelMode="active"');
    expect(shell).toContain('storageKey="lifeops:nav-rail-width:compact"');
    expect(shell).not.toContain("defaultWidth={296}");
    expect(nav).toContain('labelMode?: "all" | "active"');
    expect(page).not.toContain("Enabling…");
  });
});

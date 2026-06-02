import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const localMessagingAdaptersDir = resolve(
  packageRoot,
  "src/lifeops/messaging/adapters",
);

function readPackageFile(path: string): string {
  return readFileSync(resolve(packageRoot, path), "utf8");
}

describe("LifeOps package boundaries", () => {
  it("keeps CLAUDE.md and AGENTS.md identical", () => {
    expect(readPackageFile("AGENTS.md")).toBe(readPackageFile("CLAUDE.md"));
  });

  it("documents LifeOps as the personal assistant owner, not the health or connector implementation home", () => {
    const guide = readPackageFile("CLAUDE.md");

    expect(guide).toContain(
      "LifeOps is the personal and executive assistant interface.",
    );
    expect(guide).toContain(
      "Health / sleep / circadian / screen-time planning",
    );
    expect(guide).toContain("belongs in `@elizaos/plugin-health`");
    expect(guide).toContain(
      "Connector, adapter, bridge, and transport clients",
    );
    expect(guide).toContain("belong in their relevant plugins");
    expect(guide).toContain("Native Apple Calendar / Reminders bridge policy");
    expect(guide).toContain("belongs in native packages");
  });

  it("keeps health and screen-time actions as plugin-health wrappers", () => {
    const healthAction = readPackageFile("src/actions/health.ts");
    const screenTimeAction = readPackageFile("src/actions/screen-time.ts");
    const healthProvider = readPackageFile("src/providers/health.ts");
    const sleepRoutes = readPackageFile("src/routes/sleep-routes.ts");
    const sleepServiceMixin = readPackageFile(
      "src/lifeops/service-mixin-sleep.ts",
    );
    const screenTimeServiceMixin = readPackageFile(
      "src/lifeops/service-mixin-screentime.ts",
    );

    expect(healthAction).toContain('from "@elizaos/plugin-health"');
    expect(healthAction).toContain("createOwnerHealthAction");
    expect(healthAction).toContain("createHealthActionRunner");
    expect(screenTimeAction).toContain('from "@elizaos/plugin-health"');
    expect(screenTimeAction).toContain("createOwnerScreenTimeAction");
    expect(screenTimeAction).toContain("createScreenTimeActionRunner");
    expect(healthProvider).toContain("createHealthProvider");
    expect(sleepRoutes).toContain("createHealthSleepRouteHandler");
    expect(sleepRoutes).toContain('from "@elizaos/plugin-health"');
    expect(sleepRoutes).not.toContain("parseWindowDaysQuery");
    expect(sleepServiceMixin).toContain("createHealthSleepServiceMethods");
    expect(sleepServiceMixin).toContain('from "@elizaos/plugin-health"');
    expect(sleepServiceMixin).not.toContain("computeSleepRegularity");
    expect(sleepServiceMixin).not.toContain("computePersonalBaseline");
    expect(screenTimeServiceMixin).toContain("buildScreenTimeBreakdown");
    expect(screenTimeServiceMixin).toContain("buildScreenTimeMetrics");
    expect(screenTimeServiceMixin).toContain("buildScreenTimeSummary");
    expect(screenTimeServiceMixin).toContain("buildScreenTimeVisibleBuckets");
    expect(screenTimeServiceMixin).toContain("computeScreenTimeRange");
    expect(screenTimeServiceMixin).toContain("enumerateScreenTimeHistoryDays");
    expect(screenTimeServiceMixin).toContain("androidUsageRowsFromSignals");
    expect(screenTimeServiceMixin).toContain(
      "mobileScreenTimeDataSourceFromSignals",
    );
    expect(screenTimeServiceMixin).toContain("isSystemInactivityApp");
    expect(screenTimeServiceMixin).toContain('from "@elizaos/plugin-health"');
    expect(screenTimeServiceMixin).not.toContain(
      "function computeScreenTimeRange",
    );
    expect(screenTimeServiceMixin).not.toContain(
      "function enumerateHistoryDays",
    );
    expect(screenTimeServiceMixin).not.toContain("function toSummaryItems");
    expect(screenTimeServiceMixin).not.toContain("function toBreakdownItems");
    expect(screenTimeServiceMixin).not.toContain(
      "function buildVisibleBuckets",
    );
    expect(screenTimeServiceMixin).not.toContain(
      "function androidUsageRowsFromSignals",
    );
    expect(screenTimeServiceMixin).not.toContain(
      "function mobileScreenTimeDataSourceFromSignals",
    );
    expect(
      existsSync(resolve(packageRoot, "src/lifeops/social-taxonomy.ts")),
    ).toBe(false);
    expect(
      existsSync(
        resolve(packageRoot, "src/activity-profile/system-inactivity-apps.ts"),
      ),
    ).toBe(false);
  });

  it("does not request health-owned app permissions from the LifeOps manifest", () => {
    const manifest = JSON.parse(readPackageFile("package.json")) as {
      elizaos?: { app?: { permissions?: string[] } };
    };
    const permissions = manifest.elizaos?.app?.permissions ?? [];

    expect(permissions).not.toContain("health");
    expect(permissions).not.toContain("screentime");
  });

  it("imports browser bridge readiness policy from plugin-browser", () => {
    const statusMixin = readPackageFile("src/lifeops/service-mixin-status.ts");
    const screenTimeMixin = readPackageFile(
      "src/lifeops/service-mixin-screentime.ts",
    );
    const browserMixin = readPackageFile("src/lifeops/service-mixin-browser.ts");
    const coreMixin = readPackageFile("src/lifeops/service-mixin-core.ts");
    const repository = readPackageFile("src/lifeops/repository.ts");
    const statusChip = readPackageFile(
      "src/components/BrowserBridgeStatusChip.tsx",
    );

    expect(statusMixin).toContain('from "@elizaos/plugin-browser"');
    expect(screenTimeMixin).toContain('from "@elizaos/plugin-browser"');
    expect(browserMixin).toContain("createBrowserBridgePageContext");
    expect(browserMixin).toContain("createBrowserBridgeTabSummary");
    expect(browserMixin).toContain(
      "resolveBrowserBridgeCompanionPairingTokenExpiresAt",
    );
    expect(browserMixin).toContain("browserBridgeDomainFromUrl");
    expect(browserMixin).toContain("MAX_BROWSER_FOCUS_WINDOW_MS");
    expect(browserMixin).toContain('from "@elizaos/plugin-browser"');
    expect(coreMixin).toContain("createBrowserBridgeCompanionStatus");
    expect(coreMixin).toContain('from "@elizaos/plugin-browser"');
    expect(statusChip).toContain('from "@elizaos/plugin-browser"');
    expect(
      existsSync(resolve(packageRoot, "src/lifeops/browser-readiness.ts")),
    ).toBe(false);
    expect(statusMixin).not.toContain("./browser-readiness");
    expect(screenTimeMixin).not.toContain("./browser-readiness");
    expect(statusChip).not.toContain("../lifeops/browser-readiness");
    expect(repository).not.toContain(
      "function createBrowserBridgeCompanionStatus",
    );
    expect(repository).not.toContain("function createBrowserBridgeTabSummary");
    expect(repository).not.toContain("function createBrowserBridgePageContext");
    expect(browserMixin).not.toContain(
      "function browserCompanionPairingTokenTtlMs",
    );
    expect(browserMixin).not.toContain(
      "function browserCompanionPairingTokenExpiresAt",
    );
    expect(browserMixin).not.toContain("function browserDomainFromUrl");
  });

  it("imports Apple Calendar native bridge policy from plugin-native-calendar", () => {
    const appleCalendar = readPackageFile("src/lifeops/apple-calendar.ts");

    expect(appleCalendar).toContain('from "@elizaos/capacitor-calendar"');
    expect(appleCalendar).toContain("appleCalendarMacosBridgeCandidates");
    expect(appleCalendar).toContain(
      "APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME",
    );
    expect(appleCalendar).not.toContain(
      'const NATIVE_DYLIB_BASENAME = "libMacWindowEffects.dylib"',
    );
    expect(appleCalendar).not.toContain(
      'path: `../../../../../../../${NATIVE_DYLIB_BASENAME}`',
    );
    expect(appleCalendar).not.toContain(
      'path: `../../../../../../${NATIVE_DYLIB_BASENAME}`',
    );
  });

  it("imports Apple Reminders native bridge policy from plugin-native-reminders", () => {
    const appleReminders = readPackageFile("src/lifeops/apple-reminders.ts");
    const manifest = readPackageFile("package.json");

    expect(manifest).toContain('"@elizaos/macosreminders"');
    expect(appleReminders).toContain('from "@elizaos/macosreminders"');
    expect(appleReminders).toContain("appleRemindersMacosBridgeCandidates");
    expect(appleReminders).toContain(
      "APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME",
    );
    expect(appleReminders).not.toContain(
      'const NATIVE_DYLIB_BASENAME = "libMacWindowEffects.dylib"',
    );
    expect(appleReminders).not.toContain(
      'path: `../../../../../../../${NATIVE_DYLIB_BASENAME}`',
    );
    expect(appleReminders).not.toContain(
      'path: `../../../../../../${NATIVE_DYLIB_BASENAME}`',
    );
  });

  it("imports Calendly message triage from plugin-calendly instead of owning a transport adapter", () => {
    const pluginSource = readPackageFile("src/plugin.ts");
    const messagingIndex = readPackageFile("src/lifeops/messaging/index.ts");

    expect(pluginSource).toContain(
      'import { CalendlyAdapter } from "@elizaos/plugin-calendly"',
    );
    expect(messagingIndex).toContain(
      'export { CalendlyAdapter } from "@elizaos/plugin-calendly"',
    );
    expect(
      existsSync(
        resolve(
          packageRoot,
          "src/lifeops/messaging/adapters/calendly-adapter.ts",
        ),
      ),
    ).toBe(false);
  });

  it("imports Gmail message triage from plugin-google instead of owning a transport adapter", () => {
    const pluginSource = readPackageFile("src/plugin.ts");
    const messagingIndex = readPackageFile("src/lifeops/messaging/index.ts");

    expect(pluginSource).toContain(
      'import { GoogleGmailAdapter } from "@elizaos/plugin-google"',
    );
    expect(messagingIndex).toContain(
      'export { GoogleGmailAdapter } from "@elizaos/plugin-google"',
    );
    expect(
      existsSync(
        resolve(packageRoot, "src/lifeops/messaging/adapters/gmail-adapter.ts"),
      ),
    ).toBe(false);
  });

  it("does not keep local message transport adapter source files", () => {
    const adapterFiles = existsSync(localMessagingAdaptersDir)
      ? readdirSync(localMessagingAdaptersDir).filter((file) =>
          /\.(ts|tsx)$/.test(file),
        )
      : [];

    expect(adapterFiles).toEqual([]);
  });

  it("does not own a rendered sleep inspection panel in the LifeOps view layer", () => {
    expect(
      existsSync(
        resolve(packageRoot, "src/components/SleepInspectionPanel.tsx"),
      ),
    ).toBe(false);
    expect(
      readPackageFile("src/components/LifeOpsOperationalPanels.tsx"),
    ).not.toContain("SleepInspectionPanel");
  });
});

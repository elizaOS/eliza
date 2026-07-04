/**
 * Guards LifeOps package boundaries: CLAUDE.md/AGENTS.md stay identical, the docs frame
 * LifeOps as the personal-assistant owner (not the health/connector implementation home),
 * and health/screen-time actions stay plugin-health wrappers. Static source asserts.
 */
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
    const rendererEntrypoint = readPackageFile("src/ui.ts");
    const sleepRoutes = readPackageFile("src/routes/sleep-routes.ts");
    const sleepServiceMixin = readPackageFile(
      "src/lifeops/domains/sleep-service.ts",
    );
    const screenTimeServiceMixin = readPackageFile(
      "src/lifeops/domains/screentime-service.ts",
    );

    expect(healthAction).toContain('from "@elizaos/plugin-health"');
    expect(healthAction).toContain("createOwnerHealthAction");
    expect(healthAction).toContain("createHealthActionRunner");
    for (const publicBarrel of [
      readPackageFile("src/index.ts"),
      readPackageFile("src/lifeops/index.ts"),
    ]) {
      expect(publicBarrel).not.toContain("detectHealthBackend");
      expect(publicBarrel).not.toContain("getDailySummary");
      expect(publicBarrel).not.toContain("getDataPoints");
      expect(publicBarrel).not.toContain("getRecentSummaries");
      expect(publicBarrel).not.toContain("HealthBridgeError");
    }
    expect(screenTimeAction).toContain('from "@elizaos/plugin-health"');
    expect(screenTimeAction).toContain("createOwnerScreenTimeAction");
    expect(screenTimeAction).toContain("createScreenTimeActionRunner");
    expect(rendererEntrypoint).not.toContain("@elizaos/plugin-health/ui");
    expect(rendererEntrypoint).not.toContain("HEALTH_ASSISTANT_COMMANDS");
    expect(rendererEntrypoint).not.toContain("HEALTH_ASSISTANT_INTENTS");
    expect(healthProvider).toContain("createHealthProvider");
    expect(
      existsSync(
        resolve(packageRoot, "src/components/MobileSignalsSetupCard.tsx"),
      ),
    ).toBe(false);
    expect(rendererEntrypoint).not.toContain("MobileSignalsSetupCard");
    const settingsSection = rendererEntrypoint;
    const googleHook = readPackageFile(
      "src/hooks/useGoogleLifeOpsConnector.ts",
    );
    expect(settingsSection).not.toContain("useLifeOpsHealthConnectors");
    expect(
      existsSync(
        resolve(packageRoot, "src/hooks/useLifeOpsHealthConnectors.ts"),
      ),
    ).toBe(false);
    expect(settingsSection).not.toContain("HealthProviderActionButton");
    expect(settingsSection).not.toContain("HealthPendingAuthActions");
    expect(settingsSection).not.toContain("health.connect(");
    expect(settingsSection).not.toContain("health.disconnect(");
    expect(settingsSection).not.toContain("health.sync(");
    const apiClient = readPackageFile("src/api/client-lifeops.ts");
    const routeManifest = readPackageFile("src/routes/plugin.ts");
    const routes = readPackageFile("src/routes/lifeops-routes.ts");
    expect(apiClient).not.toContain("startHealthLifeOpsConnector");
    expect(apiClient).not.toContain("disconnectHealthLifeOpsConnector");
    expect(apiClient).not.toContain("syncLifeOpsHealth");
    expect(apiClient).not.toContain(
      "/api/lifeops/connectors/health/${encodeURIComponent(provider)}/start",
    );
    expect(apiClient).not.toContain(
      "/api/lifeops/connectors/health/${encodeURIComponent(provider)}/disconnect",
    );
    expect(apiClient).not.toContain("/api/lifeops/health/sync");
    for (const source of [routeManifest, routes]) {
      expect(source).not.toContain("/api/lifeops/health/sync");
      expect(source).not.toContain(
        "/api/lifeops/connectors/health/:provider/start",
      );
      expect(source).not.toContain(
        "/api/lifeops/connectors/health/:provider/disconnect",
      );
      expect(source).not.toContain(
        "^\\/api\\/lifeops\\/connectors\\/health\\/([^/]+)\\/start$",
      );
      expect(source).not.toContain(
        "^\\/api\\/lifeops\\/connectors\\/health\\/([^/]+)\\/disconnect$",
      );
    }
    expect(settingsSection).not.toContain("HealthProviderActionButton");
    expect(settingsSection).not.toContain("HealthPendingAuthActions");
    expect(settingsSection).not.toContain("HealthConnectorRedirectCard");
    expect(settingsSection).not.toContain('dispatchFocusConnector("health")');
    expect(settingsSection).not.toContain("GoogleManagementButton");
    expect(settingsSection).not.toContain('dispatchFocusConnector("google")');
    expect(settingsSection).not.toContain("GoogleConnectButton");
    expect(settingsSection).not.toContain("GoogleAddAccountButton");
    expect(settingsSection).not.toContain("GoogleDisconnectButton");
    expect(settingsSection).not.toContain("GoogleAccountDisconnectButton");
    expect(settingsSection).not.toContain("PendingAuthBanner");
    expect(settingsSection).not.toContain("settings-google-${side}-connect");
    expect(settingsSection).not.toContain("settings-google-${side}-disconnect");
    expect(settingsSection).not.toContain("settings-google-${side}-add");
    expect(settingsSection).not.toContain("settings-google-${side}-auth");
    expect(googleHook).not.toContain("deleteConnectorAccount");
    expect(googleHook).not.toContain("pendingAuthUrl");
    expect(googleHook).not.toContain("connectAdditional");
    expect(googleHook).not.toContain("disconnectAccount");
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
    const statusMixin = readPackageFile(
      "src/lifeops/domains/status-service.ts",
    );
    const screenTimeMixin = readPackageFile(
      "src/lifeops/domains/screentime-service.ts",
    );
    const browserMixin = readPackageFile(
      "src/lifeops/domains/browser-service.ts",
    );
    const coreMixin = readPackageFile("src/lifeops/service-mixin-core.ts");
    const repository = readPackageFile("src/lifeops/repository.ts");
    const rendererEntrypoint = readPackageFile("src/ui.ts");
    const settingsSection = rendererEntrypoint;
    const uiEntrypoint = readPackageFile("src/ui.ts");
    const apiClient = readPackageFile("src/api/client-lifeops.ts");
    const connectorAction = readPackageFile("src/actions/connector.ts");
    const routeManifest = readPackageFile("src/routes/plugin.ts");
    const routes = readPackageFile("src/routes/lifeops-routes.ts");
    const publicBarrels = [
      readPackageFile("src/index.ts"),
      readPackageFile("src/public.ts"),
      readPackageFile("src/lifeops/index.ts"),
      readPackageFile("src/contracts/index.ts"),
    ];

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
    expect(
      existsSync(
        resolve(packageRoot, "src/components/BrowserBridgeStatusChip.tsx"),
      ),
    ).toBe(false);
    expect(settingsSection).not.toContain("BrowserBridgeStatusChip");
    expect(settingsSection).not.toContain("BrowserBridgeRedirectCard");
    expect(settingsSection).not.toContain("BrowserBridgeSetupPanel");
    expect(uiEntrypoint).not.toContain("BrowserBridgeSetupPanel");
    expect(uiEntrypoint).not.toContain("LifeOpsBrowserSetupPanel");
    expect(uiEntrypoint).not.toContain("./components/BrowserBridgeSetupPanel");
    expect(apiClient).toContain("getBrowserBridgeSettings");
    expect(apiClient).toContain("listBrowserBridgeCompanions");
    expect(apiClient).not.toContain("updateBrowserBridgeSettings");
    expect(apiClient).not.toContain("getBrowserBridgePackageStatus");
    expect(apiClient).not.toContain("autoPairBrowserBridgeCompanion");
    expect(apiClient).not.toContain("createBrowserBridgeCompanionPairing");
    expect(apiClient).not.toContain("buildBrowserBridgeCompanionPackage");
    expect(apiClient).not.toContain("openBrowserBridgeCompanionPackagePath");
    expect(apiClient).not.toContain("openBrowserBridgeCompanionManager");
    expect(apiClient).not.toContain("downloadBrowserBridgeCompanionPackage");
    expect(apiClient).not.toContain("listBrowserBridgeTabs");
    expect(apiClient).not.toContain("getBrowserBridgeCurrentPage");
    expect(apiClient).not.toContain("syncBrowserBridgeState");
    expect(connectorAction).not.toContain(
      "service.createBrowserCompanionPairing",
    );
    expect(connectorAction).not.toContain("Browser bridge pairing created");
    expect(routeManifest).not.toContain("/api/lifeops/browser/register");
    expect(routes).not.toContain("/api/lifeops/browser/register");
    expect(routes).not.toContain("recordBrowserSessionRegistration");
    expect(routes).not.toContain("BrowserSessionRegistration");
    for (const publicBarrel of publicBarrels) {
      expect(publicBarrel).not.toContain("detectPasswordManagerBackend");
      expect(publicBarrel).not.toContain(
        "getBrowserBridgeCompanionPackageStatus",
      );
      expect(publicBarrel).not.toContain("password-manager-bridge");
      expect(publicBarrel).not.toContain('from "@elizaos/plugin-browser"');
    }
    expect(
      existsSync(
        resolve(packageRoot, "src/lifeops/password-manager-bridge.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(packageRoot, "src/components/BrowserBridgeSetupPanel.tsx"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          packageRoot,
          "src/components/BrowserBridgeSetupPanel.visual-copy.test.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(resolve(packageRoot, "src/lifeops/browser-readiness.ts")),
    ).toBe(false);
    expect(statusMixin).not.toContain("./browser-readiness");
    expect(screenTimeMixin).not.toContain("./browser-readiness");
    expect(settingsSection).not.toContain("../lifeops/browser-readiness");
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

  // Apple Calendar bridge moved to @elizaos/plugin-calendar; its native bridge
  // boundary is asserted in that package's test suite.

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
      "path: `../../../../../../../${NATIVE_DYLIB_BASENAME}`",
    );
    expect(appleReminders).not.toContain(
      "path: `../../../../../../${NATIVE_DYLIB_BASENAME}`",
    );
  });

  it("imports Calendly message triage from plugin-calendly instead of owning a transport adapter", () => {
    const pluginSource = readPackageFile("src/plugin.ts");
    const messagingIndex = readPackageFile("src/lifeops/messaging/index.ts");

    expect(pluginSource).toContain(
      'import { CalendlyAdapter } from "@elizaos/plugin-calendly"',
    );
    expect(messagingIndex).not.toContain("CalendlyAdapter");
    expect(messagingIndex).not.toContain("@elizaos/plugin-calendly");
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
    expect(messagingIndex).not.toContain("GoogleGmailAdapter");
    expect(messagingIndex).not.toContain("@elizaos/plugin-google");
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

  it("does not re-export connector-owned message adapters from the LifeOps messaging barrel", () => {
    const messagingIndex = readPackageFile("src/lifeops/messaging/index.ts");

    expect(messagingIndex).toContain("createOwnerSendPolicy");
    for (const adapterSymbol of [
      "BrowserBridgeAdapter",
      "CalendlyAdapter",
      "GoogleGmailAdapter",
      "XDmAdapter",
    ]) {
      expect(messagingIndex).not.toContain(adapterSymbol);
    }
    for (const connectorPackage of [
      "@elizaos/plugin-browser",
      "@elizaos/plugin-calendly",
      "@elizaos/plugin-google",
      "@elizaos/plugin-x",
    ]) {
      expect(messagingIndex).not.toContain(connectorPackage);
    }
  });

  it("keeps messaging account setup in connector plugins instead of LifeOps views", () => {
    const rendererEntrypoint = readPackageFile("src/ui.ts");
    const discordHook = readPackageFile("src/hooks/useDiscordConnector.ts");
    const telegramHook = readPackageFile("src/hooks/useTelegramConnector.ts");
    const signalHook = readPackageFile("src/hooks/useSignalConnector.ts");
    const whatsappHook = readPackageFile("src/hooks/useWhatsAppConnector.ts");
    const xHook = readPackageFile("src/hooks/useLifeOpsXConnector.ts");
    const apiClient = readPackageFile("src/api/client-lifeops.ts");
    const routeManifest = readPackageFile("src/routes/plugin.ts");
    const routes = readPackageFile("src/routes/lifeops-routes.ts");
    const connectorAction = readPackageFile("src/actions/connector.ts");
    const signalMixin = readPackageFile("src/lifeops/service-mixin-signal.ts");
    const signalContribution = readPackageFile(
      "src/lifeops/connectors/signal.ts",
    );

    expect(
      existsSync(
        resolve(packageRoot, "src/components/MessagingConnectorCards.tsx"),
      ),
    ).toBe(false);
    expect(rendererEntrypoint).not.toContain("MessagingConnectorCards");
    expect(rendererEntrypoint).not.toContain("ConnectorManagementButton");
    expect(rendererEntrypoint).not.toContain("connector-telegram-phone");
    expect(rendererEntrypoint).not.toContain("connector-telegram-code");
    expect(rendererEntrypoint).not.toContain("connector-telegram-password");
    expect(rendererEntrypoint).not.toContain("Send Telegram code");
    expect(rendererEntrypoint).not.toContain("Verify Telegram code");
    expect(rendererEntrypoint).not.toContain("Submit Telegram password");
    expect(telegramHook).not.toContain("startTelegramAuth");
    expect(telegramHook).not.toContain("submitTelegramAuth");
    expect(telegramHook).not.toContain("cancelTelegramAuth");
    expect(telegramHook).not.toContain("disconnectTelegramConnector");
    expect(apiClient).not.toContain("startTelegramAuth");
    expect(apiClient).not.toContain("submitTelegramAuth");
    expect(apiClient).not.toContain("cancelTelegramAuth");
    expect(apiClient).not.toContain("disconnectTelegramConnector");
    for (const source of [routeManifest, routes, apiClient]) {
      expect(source).not.toContain("/api/lifeops/connectors/telegram/start");
      expect(source).not.toContain("/api/lifeops/connectors/telegram/submit");
      expect(source).not.toContain("/api/lifeops/connectors/telegram/cancel");
      expect(source).not.toContain(
        "/api/lifeops/connectors/telegram/disconnect",
      );
    }
    expect(connectorAction).not.toContain("service.disconnectTelegram");
    const telegramMixin = readPackageFile(
      "src/lifeops/service-mixin-telegram.ts",
    );
    const telegramContribution = readPackageFile(
      "src/lifeops/connectors/telegram.ts",
    );
    expect(telegramMixin).not.toContain("startTelegramAuth");
    expect(telegramMixin).not.toContain("submitTelegramAuth");
    expect(telegramMixin).not.toContain("disconnectTelegram");
    expect(telegramContribution).not.toContain("service.disconnectTelegram");
    expect(rendererEntrypoint).not.toContain("connector-signal-link");
    expect(rendererEntrypoint).not.toContain("connector-signal-cancel-pairing");
    expect(rendererEntrypoint).not.toContain("Signal pairing QR code");
    expect(rendererEntrypoint).not.toContain("Generating QR code");
    expect(rendererEntrypoint).not.toContain("Link Signal");
    expect(rendererEntrypoint).not.toContain("Cancel Signal pairing");
    expect(signalHook).not.toContain("startLifeOpsSignalPairing");
    expect(signalHook).not.toContain("getLifeOpsSignalPairingStatus");
    expect(signalHook).not.toContain("stopLifeOpsSignalPairing");
    expect(signalHook).not.toContain("disconnectSignalConnector");
    expect(apiClient).not.toContain("startLifeOpsSignalPairing");
    expect(apiClient).not.toContain("getLifeOpsSignalPairingStatus");
    expect(apiClient).not.toContain("stopLifeOpsSignalPairing");
    expect(apiClient).not.toContain("disconnectSignalConnector");
    for (const source of [routeManifest, routes, apiClient]) {
      expect(source).not.toContain("/api/lifeops/connectors/signal/pair");
      expect(source).not.toContain(
        "/api/lifeops/connectors/signal/pairing-status",
      );
      expect(source).not.toContain("/api/lifeops/connectors/signal/stop");
      expect(source).not.toContain("/api/lifeops/connectors/signal/disconnect");
    }
    expect(connectorAction).not.toContain("service.disconnectSignal");
    expect(signalContribution).not.toContain("service.disconnectSignal");
    expect(signalMixin).not.toContain("startSignalPairing");
    expect(signalMixin).not.toContain("getSignalPairingStatus");
    expect(signalMixin).not.toContain("stopSignalPairing");
    expect(signalMixin).not.toContain("disconnectSignal");
    expect(rendererEntrypoint).not.toContain("connector-whatsapp-pair");
    expect(rendererEntrypoint).not.toContain("WhatsAppQrOverlay");
    expect(rendererEntrypoint).not.toContain("Pair WhatsApp");
    expect(rendererEntrypoint).not.toContain("Hide WhatsApp QR");
    expect(rendererEntrypoint).not.toContain("WhatsApp QR Code");
    expect(
      existsSync(resolve(packageRoot, "src/components/WhatsAppQrOverlay.tsx")),
    ).toBe(false);
    expect(
      existsSync(resolve(packageRoot, "src/hooks/useWhatsAppPairing.ts")),
    ).toBe(false);
    expect(whatsappHook).not.toContain("startPairing");
    expect(whatsappHook).not.toContain("stopPairing");
    expect(whatsappHook).not.toContain("disconnect");
    expect(whatsappHook).not.toContain("onWsEvent");
    expect(rendererEntrypoint).not.toContain("connector-discord-connect");
    expect(rendererEntrypoint).not.toContain("connector-discord-disconnect");
    expect(rendererEntrypoint).not.toContain("connector-discord-open-desktop");
    expect(rendererEntrypoint).not.toContain("connector-discord-source");
    expect(rendererEntrypoint).not.toContain(
      "Open Discord in Eliza Desktop Browser",
    );
    expect(discordHook).not.toContain("startDiscordConnector");
    expect(discordHook).not.toContain("disconnectDiscordConnector");
    expect(apiClient).not.toContain("startDiscordConnector");
    expect(apiClient).not.toContain("disconnectDiscordConnector");
    for (const source of [routeManifest, routes, apiClient]) {
      expect(source).not.toContain("/api/lifeops/connectors/discord/connect");
      expect(source).not.toContain(
        "/api/lifeops/connectors/discord/disconnect",
      );
    }
    const discordContribution = readPackageFile(
      "src/lifeops/connectors/discord.ts",
    );
    expect(connectorAction).not.toContain("service.authorizeDiscordConnector");
    expect(connectorAction).not.toContain("service.disconnectDiscord");
    expect(discordContribution).not.toContain("service.disconnectDiscord");
    expect(xHook).not.toContain("startXLifeOpsConnector");
    expect(xHook).not.toContain("disconnectXLifeOpsConnector");
    expect(xHook).not.toContain("connect,");
    expect(xHook).not.toContain("disconnect,");
    expect(apiClient).not.toContain("startXLifeOpsConnector");
    expect(apiClient).not.toContain("disconnectXLifeOpsConnector");
    expect(apiClient).not.toContain("upsertXLifeOpsConnector");
    for (const source of [routeManifest, routes, apiClient]) {
      expect(source).not.toContain("/api/lifeops/connectors/x/start");
      expect(source).not.toContain("/api/lifeops/connectors/x/disconnect");
      expect(source).not.toContain("/api/lifeops/connectors/x/success");
      expect(source).not.toContain('/api/lifeops/connectors/x"');
    }
    const xMixin = readPackageFile("src/lifeops/service-mixin-x.ts");
    const xContribution = readPackageFile("src/lifeops/connectors/x.ts");
    expect(connectorAction).not.toContain("service.startXConnector");
    expect(connectorAction).not.toContain("service.disconnectXConnector");
    expect(xContribution).not.toContain("service.disconnectXConnector");
    expect(xMixin).not.toContain("startXConnector");
    expect(xMixin).not.toContain("disconnectXConnector");
    expect(xMixin).not.toContain("upsertXConnector");
  });

  it("does not own a rendered sleep inspection panel in the LifeOps view layer", () => {
    expect(
      existsSync(
        resolve(packageRoot, "src/components/SleepInspectionPanel.tsx"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(packageRoot, "src/components/LifeOpsOperationalPanels.tsx"),
      ),
    ).toBe(false);
    const rendererEntrypoint = readPackageFile("src/ui.ts");
    expect(rendererEntrypoint).not.toContain("SleepInspectionPanel");
    expect(rendererEntrypoint).not.toContain("useLifeOpsScheduleState");
    expect(
      existsSync(resolve(packageRoot, "src/hooks/useLifeOpsScheduleState.ts")),
    ).toBe(false);
    expect(
      existsSync(
        resolve(packageRoot, "src/hooks/useLifeOpsScheduleInspection.ts"),
      ),
    ).toBe(false);
    expect(rendererEntrypoint).not.toContain("useLifeOpsCapabilitiesStatus");
    expect(rendererEntrypoint).not.toContain("LifeOpsSchedulePanel");
    expect(rendererEntrypoint).not.toContain(".connect(");
    expect(rendererEntrypoint).not.toContain(".disconnect(");
  });
});

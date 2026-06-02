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
    expect(screenTimeServiceMixin).toContain("classifyScreenTimeTarget");
    expect(screenTimeServiceMixin).toContain("computeScreenTimeRange");
    expect(screenTimeServiceMixin).toContain("enumerateScreenTimeHistoryDays");
    expect(screenTimeServiceMixin).toContain("isSystemInactivityApp");
    expect(screenTimeServiceMixin).toContain('from "@elizaos/plugin-health"');
    expect(screenTimeServiceMixin).not.toContain(
      "function computeScreenTimeRange",
    );
    expect(screenTimeServiceMixin).not.toContain(
      "function enumerateHistoryDays",
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

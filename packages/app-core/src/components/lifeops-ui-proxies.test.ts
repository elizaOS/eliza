import { describe, expect, it } from "vitest";
import {
  LifeOpsBrowserSetupPanel as proxiedBrowserSetupPanel,
} from "./connectors/LifeOpsBrowserSetupPanel";
import { LifeOpsSettingsSection as proxiedSettingsSection } from "./settings/LifeOpsSettingsSection";
import { WebsiteBlockerSettingsCard as proxiedWebsiteBlockerSettingsCard } from "./settings/WebsiteBlockerSettingsCard";
import {
  LifeOpsBrowserSetupPanel,
  LifeOpsSettingsSection,
  WebsiteBlockerSettingsCard,
} from "@elizaos/app-lifeops/ui";

describe("LifeOps UI proxies", () => {
  it("re-exports the app-lifeops browser setup panel", () => {
    expect(proxiedBrowserSetupPanel).toBe(LifeOpsBrowserSetupPanel);
  });

  it("re-exports the app-lifeops settings section", () => {
    expect(proxiedSettingsSection).toBe(LifeOpsSettingsSection);
  });

  it("re-exports the app-lifeops website blocker card", () => {
    expect(proxiedWebsiteBlockerSettingsCard).toBe(
      WebsiteBlockerSettingsCard,
    );
  });
});

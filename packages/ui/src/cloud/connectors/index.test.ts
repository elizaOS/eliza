/** Verifies the cloud-connectors Settings-section barrel through the real settings registry. */

/**
 * Coverage for the cloud connectors domain barrel: the stable section id,
 * import-time inertness (registration stays the host's boot decision), the
 * exact SettingsSectionDef contract handed to the settings registry,
 * replace-by-id idempotency, and the shell/body composition of the adapter.
 * Real modules only — the shared UI registry host is reset per test, no mocks.
 */
import { Plug } from "lucide-react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSettingsSection,
  getSettingsSectionRegistryVersion,
  listSettingsSections,
} from "../../components/settings/settings-section-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { CloudSettingsSectionShell } from "../settings/CloudSettingsSectionShell";
import { CloudConnectorsSettingsBody } from "./CloudConnectorsUpsell";
import {
  CLOUD_CONNECTORS_SECTION_ID,
  CloudConnectorsSettingsSection,
  registerCloudConnectorsSettingsSection,
} from "./index";

// Snapshot taken at module scope, before any test-side registry reset can
// run: it is the ground truth of what importing the barrel did to the IA.
const sectionsAtImport = listSettingsSections();

beforeEach(() => {
  resetUiRegistryHostForTests();
});

describe("CLOUD_CONNECTORS_SECTION_ID", () => {
  it("is the stable cloud-connectors id, distinct from the local-process connectors section", () => {
    expect(CLOUD_CONNECTORS_SECTION_ID).toBe("cloud-connectors");
  });
});

describe("module import", () => {
  it("leaves the Settings IA untouched; registering is the host's decision, not an import side effect", () => {
    expect(
      sectionsAtImport.some(
        (section) => section.id === CLOUD_CONNECTORS_SECTION_ID,
      ),
    ).toBe(false);
  });
});

describe("registerCloudConnectorsSettingsSection", () => {
  it("registers the full section contract under the stable id", () => {
    registerCloudConnectorsSettingsSection();

    const section = getSettingsSection(CLOUD_CONNECTORS_SECTION_ID);
    if (!section) {
      throw new Error("expected the cloud-connectors section to be registered");
    }
    expect(section.label).toBe("settings.sections.cloudConnectors.label");
    expect(section.defaultLabel).toBe("Cloud Connectors");
    expect(section.icon).toBe(Plug);
    expect(section.tone).toBe("accent");
    expect(section.hue).toBe("accent");
    expect(section.group).toBe("agent");
    expect(section.titleKey).toBe("settings.sections.cloudConnectors.title");
    expect(section.defaultTitle).toBe("Cloud Connectors");
    expect(section.prominence).toBe("secondary");
    expect(section.viewKind).toBe("release");
    expect(section.cloudOnly).toBe(true);
    expect(section.Component).toBe(CloudConnectorsSettingsSection);
    expect(
      listSettingsSections().filter(
        (entry) => entry.id === CLOUD_CONNECTORS_SECTION_ID,
      ),
    ).toHaveLength(1);
  });

  it("is idempotent: a second registration replaces by id instead of duplicating", () => {
    registerCloudConnectorsSettingsSection();
    const versionAfterFirst = getSettingsSectionRegistryVersion();

    registerCloudConnectorsSettingsSection();

    expect(getSettingsSectionRegistryVersion()).toBe(versionAfterFirst + 1);
    const entries = listSettingsSections().filter(
      (entry) => entry.id === CLOUD_CONNECTORS_SECTION_ID,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.Component).toBe(CloudConnectorsSettingsSection);
  });

  it("contributes exactly one agent-group section when the store started empty", () => {
    expect(
      listSettingsSections().some((entry) => entry.group === "agent"),
    ).toBe(false);

    registerCloudConnectorsSettingsSection();

    expect(
      listSettingsSections().some(
        (entry) =>
          entry.id === CLOUD_CONNECTORS_SECTION_ID && entry.group === "agent",
      ),
    ).toBe(true);
  });
});

describe("CloudConnectorsSettingsSection", () => {
  it("mounts the connectors body inside the cloud settings provider shell", () => {
    const element = CloudConnectorsSettingsSection();

    expect(element.type).toBe(CloudSettingsSectionShell);
    const { children } = element.props;
    expect(isValidElement(children)).toBe(true);
    if (!isValidElement(children)) {
      throw new Error("expected the shell to wrap the connectors body element");
    }
    expect(children.type).toBe(CloudConnectorsSettingsBody);
    expect(children.props).toEqual({});
  });
});

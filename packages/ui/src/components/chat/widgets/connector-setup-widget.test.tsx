// @vitest-environment jsdom
//
// Behavior lock for the connector-setup widget + its shared collapsible shell
// (#14412). Real components, jsdom DOM assertions — no mocks of the units under
// test. Covers the four contracts the issue names: start-expanded-when-
// unconfigured, auto-collapse-on-connect, the minimal/Advanced disclosure, and
// the field-tier derivation.

import type { PluginParam } from "@elizaos/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveConnectorFieldTiers,
  isConnectorConfigured,
} from "./connector-field-tiers";
import { ConnectorSetupWidget } from "./connector-setup-widget";

afterEach(cleanup);

const UNCONFIGURED: PluginParam[] = [
  { key: "DISCORD_TOKEN", required: true, isSet: false, label: "Bot Token" },
  { key: "DISCORD_APP_ID", required: true, isSet: false, label: "App ID" },
  { key: "DISCORD_GUILD_ID", required: false, isSet: true, label: "Guild ID" },
];

const CONFIGURED: PluginParam[] = [
  { key: "DISCORD_TOKEN", required: true, isSet: true, label: "Bot Token" },
  { key: "DISCORD_APP_ID", required: true, isSet: true, label: "App ID" },
  { key: "DISCORD_GUILD_ID", required: false, isSet: true, label: "Guild ID" },
];

describe("deriveConnectorFieldTiers", () => {
  it("puts required/unset params in minimal and set optionals in advanced", () => {
    const { minimal, advanced } = deriveConnectorFieldTiers(UNCONFIGURED);
    expect(minimal.map((p) => p.key)).toEqual([
      "DISCORD_TOKEN",
      "DISCORD_APP_ID",
    ]);
    expect(advanced.map((p) => p.key)).toEqual(["DISCORD_GUILD_ID"]);
  });

  it("reports configured only when every required param is set", () => {
    expect(isConnectorConfigured(UNCONFIGURED)).toBe(false);
    expect(isConnectorConfigured(CONFIGURED)).toBe(true);
  });
});

describe("ConnectorSetupWidget shell", () => {
  it("starts EXPANDED while unconfigured", () => {
    const { getByTestId, queryByTestId } = render(
      <ConnectorSetupWidget
        id="discord"
        name="Discord"
        params={UNCONFIGURED}
        onSetup={vi.fn()}
      />,
    );
    const shell = getByTestId("connector-widget-discord");
    expect(shell.getAttribute("data-expanded")).toBe("true");
    expect(getByTestId("connector-widget-discord-body")).toBeTruthy();
    expect(queryByTestId("connector-widget-discord-summary")).toBeNull();
  });

  it("starts COLLAPSED (summary only) once connected", () => {
    const { getByTestId, queryByTestId } = render(
      <ConnectorSetupWidget
        id="discord"
        name="Discord"
        params={CONFIGURED}
        onSetup={vi.fn()}
      />,
    );
    const shell = getByTestId("connector-widget-discord");
    expect(shell.getAttribute("data-expanded")).toBe("false");
    const summary = getByTestId("connector-widget-discord-summary");
    expect(summary.textContent).toContain("Discord connected");
    // Collapsed off-screen widgets skip layout/paint via content-visibility.
    expect(summary.className).toContain("[content-visibility:auto]");
    expect(queryByTestId("connector-widget-discord-body")).toBeNull();
  });

  it("re-expands from the collapsed summary via the chevron", () => {
    const { getByTestId } = render(
      <ConnectorSetupWidget
        id="discord"
        name="Discord"
        params={CONFIGURED}
        onSetup={vi.fn()}
      />,
    );
    fireEvent.click(getByTestId("connector-widget-discord-toggle"));
    expect(
      getByTestId("connector-widget-discord").getAttribute("data-expanded"),
    ).toBe("true");
    expect(getByTestId("connector-widget-discord-body")).toBeTruthy();
  });

  it("hides advanced fields until the Advanced dropdown is opened", () => {
    const { getByTestId, queryByText } = render(
      <ConnectorSetupWidget
        id="discord"
        name="Discord"
        params={UNCONFIGURED}
        onSetup={vi.fn()}
      />,
    );
    // Advanced trigger present, count reflects the set-optional field.
    const toggle = getByTestId("connector-widget-discord-advanced-toggle");
    expect(toggle.textContent).toContain("Advanced");
    expect(toggle.textContent).toContain("(1)");

    // Radix Collapsible keeps content out of the a11y tree while closed.
    fireEvent.click(toggle);
    expect(
      getByTestId("connector-widget-discord-advanced-toggle").textContent,
    ).toContain("Hide advanced");
    expect(queryByText("Guild ID")).toBeTruthy();
  });

  it("routes setup through onSetup (never plain secret fields)", () => {
    const onSetup = vi.fn();
    const { getByTestId } = render(
      <ConnectorSetupWidget
        id="discord"
        name="Discord"
        params={UNCONFIGURED}
        onSetup={onSetup}
      />,
    );
    fireEvent.click(getByTestId("connector-widget-discord-setup"));
    expect(onSetup).toHaveBeenCalledWith("discord");
    // No password/secret <input> is rendered in-transcript.
    expect(
      getByTestId("connector-widget-discord").querySelectorAll(
        "input[type='password']",
      ).length,
    ).toBe(0);
  });
});

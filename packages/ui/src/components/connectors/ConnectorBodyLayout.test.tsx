// @vitest-environment jsdom
//
// Locks the connector-body PLACEMENT rule that Settings → Connectors and the
// /connectors page both depend on (issue #10281). The bug: Settings rendered the
// config form OR the setup panel (either/or), so telegram bot-token mode — which
// has BOTH — silently dropped its TelegramBotSetupPanel. This asserts the panel
// is co-rendered with the form, never instead of it.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorBodyLayout } from "./ConnectorBodyLayout";

afterEach(cleanup);

const form = <div data-testid="config-form">form</div>;
const panel = <div data-testid="setup-panel">panel</div>;
const fallback = <div data-testid="fallback">fallback</div>;

describe("ConnectorBodyLayout", () => {
  it("co-renders the form AND the setup panel when both exist (telegram bot mode)", () => {
    render(
      <ConnectorBodyLayout
        showPluginConfig
        configForm={form}
        setupPanel={panel}
        fallback={fallback}
      />,
    );
    // The exact regression from #10281: the panel must NOT be dropped when the
    // config form shows.
    expect(screen.getByTestId("config-form")).toBeTruthy();
    expect(screen.getByTestId("setup-panel")).toBeTruthy();
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("renders the form only when there is no setup panel (discord bot mode)", () => {
    render(
      <ConnectorBodyLayout
        showPluginConfig
        configForm={form}
        setupPanel={null}
        fallback={fallback}
      />,
    );
    expect(screen.getByTestId("config-form")).toBeTruthy();
    expect(screen.queryByTestId("setup-panel")).toBeNull();
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("renders the setup panel only when there is no config form (local-setup modes)", () => {
    render(
      <ConnectorBodyLayout
        showPluginConfig={false}
        configForm={form}
        setupPanel={panel}
        fallback={fallback}
      />,
    );
    expect(screen.queryByTestId("config-form")).toBeNull();
    expect(screen.getByTestId("setup-panel")).toBeTruthy();
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("renders the fallback when there is neither a form nor a panel", () => {
    render(
      <ConnectorBodyLayout
        showPluginConfig={false}
        configForm={form}
        setupPanel={null}
        fallback={fallback}
      />,
    );
    expect(screen.queryByTestId("config-form")).toBeNull();
    expect(screen.queryByTestId("setup-panel")).toBeNull();
    expect(screen.getByTestId("fallback")).toBeTruthy();
  });

  it("applies the caller's container spacing for the config branch", () => {
    const { container } = render(
      <ConnectorBodyLayout
        showPluginConfig
        className="space-y-3"
        configForm={form}
        setupPanel={panel}
        fallback={fallback}
      />,
    );
    expect(container.querySelector(".space-y-3")).toBeTruthy();
  });
});

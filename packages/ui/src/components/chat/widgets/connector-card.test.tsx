/** Verifies ConnectorCardWidget through the package's configured test harness. */
// @vitest-environment jsdom
//
// The [CONNECTOR:<pluginId>] card: OAuth-capable connectors show a single
// Authorize CTA that starts the connector-account OAuth flow and opens an
// https-only URL; token-only connectors show Add token, which reveals a masked
// secret form saving through updateSecrets (value never rendered back);
// connected connectors show a passive Connected state. jsdom render with the
// typed ElizaClient and the connector-mode registry mocked (no backend).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../../api/client-types-config";
import { __setAppValueForTests } from "../../../state/app-store";

const { clientMock, modesMock } = vi.hoisted(() => ({
  clientMock: {
    getPlugins: vi.fn(),
    startConnectorAccountOAuth: vi.fn(),
    updateSecrets: vi.fn(),
    updatePlugin: vi.fn(),
  },
  modesMock: vi.fn(),
}));

vi.mock("../../../api/client", () => ({ client: clientMock }));
vi.mock("../inline-connector-modes", () => ({
  connectorWidgetModes: modesMock,
}));

import { ConnectorCardWidget } from "./connector-card";

function pluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "slack",
    name: "Slack",
    description: "Send and read Slack messages.",
    enabled: false,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  };
}

describe("ConnectorCardWidget", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  beforeEach(() => {
    clientMock.getPlugins.mockReset();
    clientMock.startConnectorAccountOAuth.mockReset();
    clientMock.updateSecrets.mockReset();
    clientMock.updatePlugin.mockReset();
    modesMock.mockReset();
    modesMock.mockReturnValue([]);
    // Interpolating `t` matching the app contract, so assertions read the
    // English defaultValue copy rather than raw catalog keys.
    __setAppValueForTests({
      t: (_key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? _key).replace(
          /\{\{(\w+)\}\}/g,
          (_m, name: string) => String(vars?.[name] ?? ""),
        ),
      elizaCloudConnected: false,
      loadPlugins: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it("renders name + description and an Authorize CTA for an OAuth connector", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ id: "google", name: "Google Workspace" })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);

    render(<ConnectorCardWidget pluginId="google" />);

    await waitFor(() => {
      expect(screen.getByText("Google Workspace")).toBeTruthy();
    });
    expect(screen.getByTestId("connector-card-authorize")).toBeTruthy();
    expect(screen.queryByTestId("connector-card-add-token")).toBeNull();
  });

  it("starts the OAuth flow and opens an https authUrl on Authorize", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ id: "google", name: "Google Workspace" })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      authUrl: "https://accounts.example.test/consent?state=s1",
    });
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    render(<ConnectorCardWidget pluginId="google" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-authorize")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-authorize"));

    await waitFor(() => {
      expect(clientMock.startConnectorAccountOAuth).toHaveBeenCalledWith(
        "google",
        "google",
        {},
      );
    });
    expect(openSpy).toHaveBeenCalledWith(
      "https://accounts.example.test/consent?state=s1",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();
  });

  it("refuses a non-https authUrl and renders the error state instead of opening it", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ id: "google" })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      // A javascript: URL must never reach window.open.
      authUrl: "javascript:alert(1)",
    });
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    render(<ConnectorCardWidget pluginId="google" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-authorize")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-authorize"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "authorization link",
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("shows Add token for a token connector and saves through updateSecrets without echoing the value", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [
        pluginInfo({
          parameters: [
            {
              key: "SLACK_BOT_TOKEN",
              type: "string",
              description: "Bot token",
              required: true,
              sensitive: true,
              currentValue: null,
              isSet: false,
            },
          ],
        }),
      ],
    });
    clientMock.updateSecrets.mockResolvedValue({
      ok: true,
      updated: ["SLACK_BOT_TOKEN"],
    });
    clientMock.updatePlugin.mockResolvedValue({ ok: true });
    const rawToken = ["xoxb", "test", String(Date.now())].join("-");

    const { container } = render(<ConnectorCardWidget pluginId="slack" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-add-token")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-add-token"));

    const input = screen.getByLabelText("SLACK_BOT_TOKEN") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(
      screen.getByTestId("connector-card-token-form").textContent,
    ).toContain("Masked input. It never lands in the transcript.");

    fireEvent.change(input, { target: { value: rawToken } });
    fireEvent.click(screen.getByTestId("connector-card-token-submit"));

    await waitFor(() => {
      expect(clientMock.updateSecrets).toHaveBeenCalledWith({
        SLACK_BOT_TOKEN: rawToken,
      });
    });
    expect(clientMock.updatePlugin).toHaveBeenCalledWith("slack", {
      enabled: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-connected")).toBeTruthy();
    });
    expect(container.textContent?.includes(rawToken)).toBe(false);
  });

  it("renders a passive Connected state for an already-connected connector", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ enabled: true, configured: true })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);

    render(<ConnectorCardWidget pluginId="slack" />);

    await waitFor(() => {
      expect(screen.getByTestId("connector-card-connected")).toBeTruthy();
    });
    expect(screen.queryByTestId("connector-card-authorize")).toBeNull();
    expect(screen.queryByTestId("connector-card-add-token")).toBeNull();
  });

  it("renders a not-found note for an unknown plugin id", async () => {
    clientMock.getPlugins.mockResolvedValue({ plugins: [] });

    render(<ConnectorCardWidget pluginId="doesnotexist" />);

    await waitFor(() => {
      expect(screen.getByText(/not found/i)).toBeTruthy();
    });
  });
});

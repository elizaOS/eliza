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
import en from "../../../i18n/locales/en.json";
import { __setAppValueForTests } from "../../../state/app-store";

const { clientMock, loadPluginsMock, modesMock } = vi.hoisted(() => ({
  clientMock: {
    getPlugins: vi.fn(),
    startConnectorAccountOAuth: vi.fn(),
    updateSecrets: vi.fn(),
    updatePlugin: vi.fn(),
  },
  loadPluginsMock: vi.fn(),
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
  it("keeps production status copy aligned with the connector contract", () => {
    expect(en["connectorcard.StorageNote"]).toBe(
      "Sent directly to the agent — never posted to chat.",
    );
    expect(en["connectorcard.AuthorizeRejected"]).toBe(
      "The connector could not start authorization.",
    );
    expect(en["connectorcard.SecretSaveRejected"]).toBe(
      "The token could not be saved. Try again.",
    );
    expect(en["connectorcard.SecretSaveUnconfirmed"]).toBe(
      "The agent did not confirm saving every required token. Try again.",
    );
    expect(en["connectorcard.EnableRejectedAfterSave"]).toBe(
      "The token was saved, but the connector could not be enabled{{detail}}",
    );
    expect(en["connectorcard.RefreshFailedAfterSave"]).toBe(
      "Connected, but the connector list could not be refreshed.",
    );
  });

  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  beforeEach(() => {
    clientMock.getPlugins.mockReset();
    clientMock.startConnectorAccountOAuth.mockReset();
    clientMock.updateSecrets.mockReset();
    clientMock.updatePlugin.mockReset();
    loadPluginsMock.mockReset();
    loadPluginsMock.mockResolvedValue(undefined);
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
      loadPlugins: loadPluginsMock,
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
      ok: true,
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
      ok: true,
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

  it("does not open or poll when OAuth returns ok:false with an https URL", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ id: "google" })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);
    clientMock.startConnectorAccountOAuth.mockResolvedValue({
      ok: false,
      authUrl: "https://accounts.example.test/consent?state=failed",
      error: "OAuth is unavailable for this connector.",
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
        "OAuth is unavailable for this connector.",
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(clientMock.getPlugins).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });

  it("renders a distinct rejection when OAuth fails without provider detail", async () => {
    clientMock.getPlugins.mockResolvedValue({
      plugins: [pluginInfo({ id: "google" })],
    });
    modesMock.mockReturnValue([
      { id: "oauth", label: "OAuth", description: "", kind: "oauth" },
    ]);
    clientMock.startConnectorAccountOAuth.mockResolvedValue({ ok: false });

    render(<ConnectorCardWidget pluginId="google" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-authorize")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-authorize"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "The connector could not start authorization.",
      );
    });
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
    expect(
      screen.getByTestId("connector-card-token-form").textContent,
    ).toContain("Sent directly to the agent — never posted to chat.");
    expect(
      screen.getByTestId("connector-card-token-form").textContent,
    ).not.toContain("encrypted");

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

  it("keeps the token form and does not enable when secret saving returns ok:false", async () => {
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
    clientMock.updateSecrets.mockResolvedValue({ ok: false, updated: [] });
    const rawToken = "xoxb-save-rejected";

    render(<ConnectorCardWidget pluginId="slack" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-add-token")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-add-token"));
    fireEvent.change(screen.getByLabelText("SLACK_BOT_TOKEN"), {
      target: { value: rawToken },
    });
    fireEvent.click(screen.getByTestId("connector-card-token-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "The token could not be saved",
      );
    });
    expect(clientMock.updatePlugin).not.toHaveBeenCalled();
    expect(loadPluginsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("connector-card-connected")).toBeNull();
    expect(
      (screen.getByLabelText("SLACK_BOT_TOKEN") as HTMLInputElement).value,
    ).toBe(rawToken);
  });

  it("does not enable when the agent omits a required key from the saved-key receipt", async () => {
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
    clientMock.updateSecrets.mockResolvedValue({ ok: true, updated: [] });

    render(<ConnectorCardWidget pluginId="slack" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-add-token")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-add-token"));
    fireEvent.change(screen.getByLabelText("SLACK_BOT_TOKEN"), {
      target: { value: "xoxb-unconfirmed" },
    });
    fireEvent.click(screen.getByTestId("connector-card-token-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "did not confirm saving every required token",
      );
    });
    expect(clientMock.updatePlugin).not.toHaveBeenCalled();
    expect(screen.queryByTestId("connector-card-connected")).toBeNull();
  });

  it("surfaces partial success and preserves retry input when enabling returns ok:false", async () => {
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
    clientMock.updatePlugin.mockResolvedValue({
      ok: false,
      error: "Plugin validation failed.",
    });
    const rawToken = "xoxb-enable-rejected";

    render(<ConnectorCardWidget pluginId="slack" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-add-token")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-add-token"));
    fireEvent.change(screen.getByLabelText("SLACK_BOT_TOKEN"), {
      target: { value: rawToken },
    });
    fireEvent.click(screen.getByTestId("connector-card-token-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "The token was saved, but the connector could not be enabled: Plugin validation failed.",
      );
    });
    expect(loadPluginsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("connector-card-connected")).toBeNull();
    expect(
      (screen.getByLabelText("SLACK_BOT_TOKEN") as HTMLInputElement).value,
    ).toBe(rawToken);
  });

  it("keeps the connected state and reports a failed list refresh", async () => {
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
    loadPluginsMock.mockRejectedValue(new Error("refresh unavailable"));

    render(<ConnectorCardWidget pluginId="slack" />);
    await waitFor(() => {
      expect(screen.getByTestId("connector-card-add-token")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connector-card-add-token"));
    fireEvent.change(screen.getByLabelText("SLACK_BOT_TOKEN"), {
      target: { value: "xoxb-refresh-failed" },
    });
    fireEvent.click(screen.getByTestId("connector-card-token-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("connector-card").textContent).toContain(
        "Connected, but the connector list could not be refreshed.",
      );
    });
    expect(screen.getByTestId("connector-card-connected")).toBeTruthy();
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

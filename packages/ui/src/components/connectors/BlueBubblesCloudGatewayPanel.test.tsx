/**
 * Exercises the BlueBubbles cloud enrollment surface with deterministic mocked
 * Cloud APIs: signed-out gating, sender-owned registration, one-time credential
 * handoff, explicit load failure, and two-step revocation. No live bridge.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudBlueBubblesGateway,
  CloudBlueBubblesRegistration,
} from "../../api";

const appMock = vi.hoisted(() => ({
  value: {
    elizaCloudConnected: true,
    setActionNotice: vi.fn(),
  },
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (state: typeof appMock.value) => unknown) =>
    selector(appMock.value),
}));

import {
  type BlueBubblesCloudGatewayApi,
  BlueBubblesCloudGatewayPanel,
} from "./BlueBubblesCloudGatewayPanel";

function gateway(
  overrides: Partial<CloudBlueBubblesGateway> = {},
): CloudBlueBubblesGateway {
  return {
    id: "gateway-1",
    bridgeId: "bb-bridge-1",
    phoneNumber: "+14155550123",
    friendlyName: "Office iPhone",
    routingMode: "sender-owned",
    agentId: null,
    userId: "user-1",
    lastSeenAt: "2026-08-05T10:05:00.000Z",
    status: "connected",
    ...overrides,
  };
}

function registration(): CloudBlueBubblesRegistration {
  return {
    id: "gateway-new",
    bridgeId: "bb-new",
    phoneNumber: "+14155550199",
    routingMode: "sender-owned",
    agentId: null,
    webhookUrl: "https://api.elizacloud.ai/api/webhooks/bluebubbles/bb-new",
    token: "bbg_secret_once",
    relayEnvironment: {
      ELIZA_CLOUD_BLUEBUBBLES_URL:
        "https://api.elizacloud.ai/api/webhooks/bluebubbles/bb-new",
      BLUEBUBBLES_BRIDGE_ID: "bb-new",
      BLUEBUBBLES_GATEWAY_TOKEN: "bbg_secret_once",
      BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14155550199",
    },
  };
}

function createApi(options?: {
  gateways?: CloudBlueBubblesGateway[];
}): BlueBubblesCloudGatewayApi & {
  listCloudBlueBubblesGateways: ReturnType<typeof vi.fn>;
  registerCloudBlueBubblesGateway: ReturnType<typeof vi.fn>;
  revokeCloudBlueBubblesGateway: ReturnType<typeof vi.fn>;
} {
  return {
    listCloudBlueBubblesGateways: vi.fn().mockResolvedValue({
      success: true,
      data: { gateways: options?.gateways ?? [] },
    }),
    registerCloudBlueBubblesGateway: vi.fn().mockResolvedValue({
      success: true,
      data: registration(),
    }),
    revokeCloudBlueBubblesGateway: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe("BlueBubblesCloudGatewayPanel", () => {
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    appMock.value.elizaCloudConnected = true;
    appMock.value.setActionNotice.mockReset();
    clipboardWrite.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(() => cleanup());

  it("requires an Eliza Cloud session before loading registration data", () => {
    appMock.value.elizaCloudConnected = false;
    const api = createApi();

    render(<BlueBubblesCloudGatewayPanel api={api} />);

    expect(screen.getByText("Connect Eliza Cloud")).toBeTruthy();
    expect(api.listCloudBlueBubblesGateways).not.toHaveBeenCalled();
  });

  it("registers the entered number for sender-owned routing and exposes the token once", async () => {
    const api = createApi();
    render(<BlueBubblesCloudGatewayPanel api={api} />);

    await screen.findByText("No phone gateway is registered yet.");
    fireEvent.change(screen.getByLabelText("iPhone phone number"), {
      target: { value: "+1 (415) 555-0199" },
    });
    fireEvent.change(screen.getByLabelText("Phone gateway name"), {
      target: { value: "Travel iPhone" },
    });
    const registerButton = screen.getByRole("button", {
      name: "Register phone gateway",
    }) as HTMLButtonElement;
    await waitFor(() => expect(registerButton.disabled).toBe(false));
    fireEvent.click(registerButton);

    await waitFor(() =>
      expect(api.registerCloudBlueBubblesGateway).toHaveBeenCalledWith({
        routingMode: "sender-owned",
        phoneNumber: "+1 (415) 555-0199",
        friendlyName: "Travel iPhone",
      }),
    );
    const environment = await screen.findByTestId(
      "bluebubbles-relay-environment",
    );
    expect(environment.textContent).toContain(
      "BLUEBUBBLES_GATEWAY_TOKEN=bbg_secret_once",
    );
    expect(screen.getByText("Travel iPhone")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy one-time relay configuration",
      }),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain(
      "BLUEBUBBLES_BRIDGE_ID=bb-new",
    );

    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    expect(screen.queryByTestId("bluebubbles-relay-environment")).toBeNull();
  });

  it("requires confirmation before revoking a registered phone", async () => {
    const api = createApi({ gateways: [gateway()] });
    render(<BlueBubblesCloudGatewayPanel api={api} />);

    await screen.findByText("Office iPhone");
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke Office iPhone" }),
    );
    expect(api.revokeCloudBlueBubblesGateway).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() =>
      expect(api.revokeCloudBlueBubblesGateway).toHaveBeenCalledWith(
        "gateway-1",
      ),
    );
    await waitFor(() => expect(screen.queryByText("Office iPhone")).toBeNull());
  });

  it("renders Cloud load failures as an unavailable state", async () => {
    const api = createApi();
    api.listCloudBlueBubblesGateways.mockRejectedValue(
      new Error("Cloud gateway unavailable"),
    );

    render(<BlueBubblesCloudGatewayPanel api={api} />);

    expect(await screen.findByText("Cloud gateway unavailable")).toBeTruthy();
    expect(
      screen.queryByText("No phone gateway is registered yet."),
    ).toBeNull();
  });
});

/** Exercises the BlueBubbles webhook boundary with deterministic Worker route fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const routePhoneMessage = mock(async () => ({
  handled: true,
  reason: "unknown_owner",
  replyText: "hello from onboarding",
  userId: "user-1",
  organizationId: "org-1",
}));
type RegisteredRouteResult = {
  handled: boolean;
  reason?: string;
  replyText?: string;
  agentId: string;
  userId: string;
  organizationId: string;
};
const routeRegisteredBlueBubblesMessage = mock(
  async (): Promise<RegisteredRouteResult> => ({
    handled: true,
    replyText: "registered agent reply",
    agentId: "registered-agent",
    userId: "registered-user",
    organizationId: "registered-org",
  }),
);
type RegisterPhoneGatewayDeviceResult = {
  id: string | null;
  registered: boolean;
  skippedReason?: "missing_phone_number" | "table_missing" | "write_failed";
};

const registeredGatewayDevice = (): RegisterPhoneGatewayDeviceResult => ({
  id: "gateway-device-1",
  registered: true,
});

const registerPhoneGatewayDevice = mock(
  async (): Promise<RegisterPhoneGatewayDeviceResult> =>
    registeredGatewayDevice(),
);
const authenticateBlueBubblesGateway = mock(
  async () =>
    null as null | {
      id: string;
      bridgeId: string;
      phoneNumber: string;
      organizationId: string;
      userId: string;
      routingMode: "sender-owned" | "fixed-agent";
      agentId: string | null;
      friendlyName: string | null;
      lastSeenAt: Date | null;
    },
);
const touchBlueBubblesGateway = mock(async () => undefined);

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routePhoneMessage,
    routeRegisteredBlueBubblesMessage,
  },
}));

mock.module("@/lib/services/phone-gateway-devices", () => ({
  authenticateBlueBubblesGateway,
  registerPhoneGatewayDevice,
  touchBlueBubblesGateway,
}));

// The route dedupes on the message guid via webhookEventsRepository.tryCreate
// (#12227 L5). Stub it as a first-time delivery so these routing tests exercise
// the routing path (dedupe itself is covered in dedupe.test.ts).
const tryCreate = mock(async () => ({ created: true, event: { id: "evt-1" } }));
const deleteByEventId = mock(async () => undefined);
mock.module("@/db/repositories/webhook-events", () => ({
  webhookEventsRepository: { tryCreate, deleteByEventId },
}));

const { default: app } = await import("./route");

const env = {
  BLUEBUBBLES_GATEWAY_SECRET: "test-secret",
  BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14159611510",
};

function request(
  body: unknown,
  headers: Record<string, string> = {},
  url = "https://api.example.test/",
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const inboundPayload = {
  type: "new-message",
  data: {
    guid: "message-1",
    text: "hi eliza",
    isFromMe: false,
    handle: {
      address: "+15555550123",
      service: "iMessage",
    },
    chats: [
      {
        guid: "iMessage;-;+15555550123",
        chatIdentifier: "+15555550123",
      },
    ],
    dateCreated: 1779175600000,
  },
};

describe("BlueBubbles webhook", () => {
  beforeEach(() => {
    routePhoneMessage.mockClear();
    routePhoneMessage.mockImplementation(async () => ({
      handled: true,
      reason: "unknown_owner",
      replyText: "hello from onboarding",
      userId: "user-1",
      organizationId: "org-1",
    }));
    routeRegisteredBlueBubblesMessage.mockClear();
    routeRegisteredBlueBubblesMessage.mockImplementation(async () => ({
      handled: true,
      replyText: "registered agent reply",
      agentId: "registered-agent",
      userId: "registered-user",
      organizationId: "registered-org",
    }));
    authenticateBlueBubblesGateway.mockClear();
    authenticateBlueBubblesGateway.mockResolvedValue(null);
    touchBlueBubblesGateway.mockClear();
    touchBlueBubblesGateway.mockImplementation(async () => undefined);
    tryCreate.mockClear();
    deleteByEventId.mockClear();
    registerPhoneGatewayDevice.mockClear();
    registerPhoneGatewayDevice.mockImplementation(async () =>
      registeredGatewayDevice(),
    );
  });

  test("rejects requests without the shared gateway secret", async () => {
    const response = await app.fetch(request(inboundPayload), env);

    expect(response.status).toBe(401);
    expect(routePhoneMessage).not.toHaveBeenCalled();
    expect(registerPhoneGatewayDevice).not.toHaveBeenCalled();
  });

  test("authenticates a registered phone and routes the sender to their own Eliza agent", async () => {
    authenticateBlueBubblesGateway.mockResolvedValueOnce({
      id: "registered-device",
      bridgeId: "bb-registered",
      phoneNumber: "+14155550123",
      organizationId: "registered-org",
      userId: "registered-user",
      routingMode: "sender-owned",
      agentId: null,
      friendlyName: "Registered iPhone",
      lastSeenAt: null,
    });
    const response = await app.fetch(
      request(
        inboundPayload,
        { authorization: "Bearer bbg_registered-token" },
        "https://api.example.test/?bridge=bb-registered",
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      reason: "unknown_owner",
      replyText: "hello from onboarding",
      organizationId: "org-1",
      userId: "user-1",
      gatewayDeviceId: "registered-device",
      gatewayDevicePhoneNumber: "+14155550123",
      gatewayDeviceBridgeId: "bb-registered",
      gatewayDeviceProvider: "bluebubbles",
      gatewayRoutingMode: "sender-owned",
    });
    expect(authenticateBlueBubblesGateway).toHaveBeenCalledWith(
      "bb-registered",
      "bbg_registered-token",
    );
    expect(touchBlueBubblesGateway).toHaveBeenCalledWith("registered-device");
    expect(tryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "bluebubbles:bb-registered:message-1",
      }),
    );
    expect(registerPhoneGatewayDevice).not.toHaveBeenCalled();
    expect(routeRegisteredBlueBubblesMessage).not.toHaveBeenCalled();
    expect(routePhoneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "registered-org",
        provider: "blooio",
        from: "+15555550123",
        to: "+14155550123",
      }),
    );
  });

  test("returns 503 before claiming dedupe when registered gateway presence fails", async () => {
    authenticateBlueBubblesGateway.mockResolvedValueOnce({
      id: "registered-device",
      bridgeId: "bb-registered",
      phoneNumber: "+14155550123",
      organizationId: "registered-org",
      userId: "registered-user",
      routingMode: "sender-owned",
      agentId: null,
      friendlyName: "Registered iPhone",
      lastSeenAt: null,
    });
    touchBlueBubblesGateway.mockRejectedValueOnce(
      new Error("presence database unavailable"),
    );

    const response = await app.fetch(
      request(
        inboundPayload,
        { authorization: "Bearer bbg_registered-token" },
        "https://api.example.test/?bridge=bb-registered",
      ),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      handled: false,
      reason: "bridge_failed",
      routingError: "BlueBubbles gateway presence update failed",
    });
    expect(tryCreate).not.toHaveBeenCalled();
    expect(routePhoneMessage).not.toHaveBeenCalled();
  });

  test("keeps legacy fixed-agent registrations pinned to their selected agent", async () => {
    authenticateBlueBubblesGateway.mockResolvedValueOnce({
      id: "registered-device",
      bridgeId: "bb-legacy",
      phoneNumber: "+14155550123",
      organizationId: "registered-org",
      userId: "registered-user",
      routingMode: "fixed-agent",
      agentId: "registered-agent",
      friendlyName: "Legacy iPhone",
      lastSeenAt: null,
    });
    const response = await app.fetch(
      request(
        inboundPayload,
        { authorization: "Bearer bbg_legacy-token" },
        "https://api.example.test/?bridge=bb-legacy",
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      replyText: "registered agent reply",
      agentId: "registered-agent",
      gatewayRoutingMode: "fixed-agent",
    });
    expect(routePhoneMessage).not.toHaveBeenCalled();
    expect(routeRegisteredBlueBubblesMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "registered-org",
        userId: "registered-user",
        agentId: "registered-agent",
      }),
    );
  });

  test("releases dedupe and returns 503 when a registered agent bridge reports failure", async () => {
    authenticateBlueBubblesGateway.mockResolvedValueOnce({
      id: "registered-device",
      bridgeId: "bb-legacy",
      phoneNumber: "+14155550123",
      organizationId: "registered-org",
      userId: "registered-user",
      routingMode: "fixed-agent",
      agentId: "registered-agent",
      friendlyName: "Legacy iPhone",
      lastSeenAt: null,
    });
    routeRegisteredBlueBubblesMessage.mockResolvedValueOnce({
      handled: false,
      reason: "bridge_failed",
      agentId: "registered-agent",
      userId: "registered-user",
      organizationId: "registered-org",
    });

    const response = await app.fetch(
      request(
        inboundPayload,
        { authorization: "Bearer bbg_legacy-token" },
        "https://api.example.test/?bridge=bb-legacy",
      ),
      env,
    );

    expect(response.status).toBe(503);
    expect(deleteByEventId).toHaveBeenCalledWith(
      "bluebubbles:bb-legacy:message-1",
      "bluebubbles",
    );
  });

  test("fails closed when a registered bridge token is invalid", async () => {
    const response = await app.fetch(
      request(
        inboundPayload,
        { authorization: "Bearer wrong-token" },
        "https://api.example.test/?bridge=bb-registered",
      ),
      env,
    );

    expect(response.status).toBe(401);
    expect(registerPhoneGatewayDevice).not.toHaveBeenCalled();
    expect(routeRegisteredBlueBubblesMessage).not.toHaveBeenCalled();
  });

  test("skips outbound echoes from the gateway device", async () => {
    const response = await app.fetch(
      request(
        {
          ...inboundPayload,
          data: {
            ...inboundPayload.data,
            isFromMe: true,
          },
        },
        { "x-eliza-gateway-secret": "test-secret" },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: "outbound_message",
    });
    expect(routePhoneMessage).not.toHaveBeenCalled();
    expect(registerPhoneGatewayDevice).not.toHaveBeenCalled();
  });

  test("skips unsupported BlueBubbles events before gateway registration", async () => {
    const response = await app.fetch(
      request(
        {
          ...inboundPayload,
          type: "message.updated",
        },
        { "x-eliza-gateway-secret": "test-secret" },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: "unsupported_event",
      type: "message.updated",
    });
    expect(routePhoneMessage).not.toHaveBeenCalled();
    expect(registerPhoneGatewayDevice).not.toHaveBeenCalled();
  });

  test("routes inbound BlueBubbles messages through the shared Blooio phone gateway", async () => {
    const response = await app.fetch(
      request(inboundPayload, { "x-eliza-gateway-secret": "test-secret" }),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      reason: "unknown_owner",
      replyText: "hello from onboarding",
      userId: "user-1",
      organizationId: "org-1",
      gatewayDeviceId: "gateway-device-1",
      gatewayDeviceRegistered: true,
      gatewayDevicePhoneNumber: "+14159611510",
      gatewayDeviceBridgeId: "default",
      gatewayDeviceProvider: "blooio",
    });
    expect(registerPhoneGatewayDevice).toHaveBeenCalledWith({
      organizationId: "00000000-0000-4000-8000-000000000000",
      provider: "blooio",
      phoneNumber: "+14159611510",
      bridgeId: "default",
      phoneAccountId: "+14159611510",
      phoneAccountLabel: "+14159611510",
      friendlyName: "+14159611510",
      sendMethod: "bluebubbles-local-bridge",
      cloudWebhookUrl: "https://api.example.test/",
      metadata: {
        eventType: "new-message",
        chatGuid: "iMessage;-;+15555550123",
        chatIdentifier: "+15555550123",
        detectedService: "iMessage",
      },
    });
    expect(routePhoneMessage).toHaveBeenCalledTimes(1);
    const calls = routePhoneMessage.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(calls[0]?.[0]).toMatchObject({
      organizationId: "00000000-0000-4000-8000-000000000000",
      provider: "blooio",
      from: "+15555550123",
      to: "+14159611510",
      body: "hi eliza",
      providerMessageId: "message-1",
      metadata: {
        bluebubblesBridgeId: "default",
        bluebubblesEventType: "new-message",
        bluebubblesChatGuid: "iMessage;-;+15555550123",
        bluebubblesChatIdentifier: "+15555550123",
        bluebubblesDateCreated: 1779175600000,
        localPhoneNumber: "+14159611510",
        phoneNumber: "+14159611510",
        phoneAccountId: "+14159611510",
        phoneAccountLabel: "+14159611510",
        phoneGatewayDeviceId: "gateway-device-1",
        phoneGatewayDeviceRegistered: true,
      },
    });
  });

  test("routes inbound messages even when gateway device registration is unavailable", async () => {
    registerPhoneGatewayDevice.mockResolvedValueOnce({
      id: null,
      registered: false,
      skippedReason: "write_failed",
    } satisfies RegisterPhoneGatewayDeviceResult);

    const response = await app.fetch(
      request(inboundPayload, { "x-eliza-gateway-secret": "test-secret" }),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      reason: "unknown_owner",
      gatewayDeviceId: null,
      gatewayDeviceRegistered: false,
      gatewayDevicePhoneNumber: "+14159611510",
      gatewayDeviceBridgeId: "default",
      gatewayDeviceProvider: "blooio",
    });
    expect(routePhoneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phoneGatewayDeviceRegistered: false,
        }),
      }),
    );
  });

  test("routes inbound messages even when gateway device registration throws", async () => {
    registerPhoneGatewayDevice.mockRejectedValueOnce(
      new Error("gateway table unavailable"),
    );

    const response = await app.fetch(
      request(inboundPayload, { "x-eliza-gateway-secret": "test-secret" }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      reason: "unknown_owner",
      gatewayDeviceId: null,
      gatewayDeviceRegistered: false,
      gatewayDevicePhoneNumber: "+14159611510",
      gatewayDeviceBridgeId: "default",
      gatewayDeviceProvider: "blooio",
    });
    expect(routePhoneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phoneGatewayDeviceId: undefined,
          phoneGatewayDeviceRegistered: false,
        }),
      }),
    );
  });

  test("pins gateway routing to 415-961-1510 when payload metadata names the personal line", async () => {
    const response = await app.fetch(
      request(
        {
          ...inboundPayload,
          data: {
            ...inboundPayload.data,
            metadata: {
              localPhoneNumber: "+14153024399",
              phoneNumber: "+14153024399",
              phoneAccountId: "+14153024399",
              phoneAccountLabel: "Personal line (+14153024399)",
            },
          },
        },
        { "x-eliza-gateway-secret": "test-secret" },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      gatewayDeviceRegistered: true,
      gatewayDevicePhoneNumber: "+14159611510",
      gatewayDeviceProvider: "blooio",
    });
    expect(registerPhoneGatewayDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: "+14159611510",
        phoneAccountId: "+14159611510",
        phoneAccountLabel: "+14159611510",
      }),
    );
    expect(routePhoneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+14159611510",
        metadata: expect.objectContaining({
          localPhoneNumber: "+14159611510",
          phoneNumber: "+14159611510",
          phoneAccountId: "+14159611510",
          phoneAccountLabel: "+14159611510",
        }),
      }),
    );
  });

  test("uses bridge query/header identity when the Blooio compatibility route forwards BlueBubbles", async () => {
    const response = await app.fetch(
      request(
        inboundPayload,
        {
          "x-eliza-gateway-secret": "test-secret",
          "x-eliza-bridge": "bluebubbles",
        },
        "https://api.example.test/?bridge=bluebubbles",
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      gatewayDeviceRegistered: true,
      gatewayDevicePhoneNumber: "+14159611510",
      gatewayDeviceBridgeId: "bluebubbles",
      gatewayDeviceProvider: "blooio",
    });
    expect(registerPhoneGatewayDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeId: "bluebubbles",
      }),
    );
    expect(routePhoneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          bluebubblesBridgeId: "bluebubbles",
        }),
      }),
    );
  });

  test("preserves onboarding replies after the user provides a preferred name", async () => {
    const response = await app.fetch(
      request(
        {
          ...inboundPayload,
          data: {
            ...inboundPayload.data,
            text: "my name is Sam",
          },
        },
        { "x-eliza-gateway-secret": "test-secret" },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      reason: "unknown_owner",
      replyText: "hello from onboarding",
    });
  });

  test("returns a retryable failure and rolls back dedupe when shared routing throws", async () => {
    routePhoneMessage.mockRejectedValueOnce(new Error("routing unavailable"));

    const response = await app.fetch(
      request(inboundPayload, { "x-eliza-gateway-secret": "test-secret" }),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      handled: false,
      reason: "bridge_failed",
      gatewayDeviceId: "gateway-device-1",
      gatewayDeviceRegistered: true,
      routingError: "BlueBubbles routing failed",
    });
    expect(deleteByEventId).toHaveBeenCalledWith(
      "bluebubbles:default:message-1",
      "bluebubbles",
    );
  });
});

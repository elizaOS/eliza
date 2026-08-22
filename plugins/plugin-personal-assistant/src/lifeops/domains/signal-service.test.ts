/**
 * Verifies the retained LifeOps Signal boundary reports explicit unsupported
 * state and cannot fabricate read or delivery success.
 */
import { describe, expect, it } from "vitest";
import { SignalDomain } from "./signal-service";

describe("SignalDomain unsupported boundary", () => {
  const domain = new SignalDomain();

  it("reports no identity, grant, or capability", async () => {
    await expect(
      domain.getSignalConnectorStatus("owner"),
    ).resolves.toMatchObject({
      provider: "signal",
      connected: false,
      inbound: false,
      // Contract-valid reason: LIFEOPS_MESSAGING_CONNECTOR_REASONS has no
      // "unsupported"; the transport-offline degradation carries that story.
      reason: "disconnected",
      identity: null,
      grant: null,
      grantedCapabilities: [],
      degradations: [
        {
          code: "signal_direct_transport_unavailable",
          retryable: false,
        },
      ],
    });
    expect(domain.lifeOpsSignalServiceConnected()).toBe(false);
    expect(domain.lifeOpsSignalServiceRegistered()).toBe(false);
  });

  it("rejects read and send instead of returning synthetic success", async () => {
    await expect(domain.readSignalInbound()).rejects.toMatchObject({
      status: 501,
    });
    await expect(
      domain.sendSignalMessage({
        recipient: "+15551234567",
        text: "hello",
      }),
    ).rejects.toMatchObject({ status: 501 });
  });
});

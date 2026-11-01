/** Exercises the Cloud host session list against the rows Cloud serves while a pairing is in flight. */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { RemoteControlCloudClient } from "../../src/remote-control/cloud-client";

function cloudSession(
  hostId: string,
  ownerId: string,
  status: string,
  controller: { deviceId: string | null; keyId: string | null } = {
    deviceId: "controller-device",
    keyId: "controller-key",
  },
): Record<string, unknown> & { id: string } {
  const now = new Date().toISOString();
  // The field set GET /api/v1/remote/sessions?hostId= serializes.
  return {
    id: randomUUID(),
    ownerId,
    grantId: randomUUID(),
    grantRevision: 1,
    hostId,
    status,
    requesterIdentity: ownerId,
    ingressUrl: null,
    ingressReason: null,
    controllerDeviceId: controller.deviceId,
    controllerKeyId: controller.keyId,
    targetKeyId: "target-key",
    grantExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function listing(sessions: Record<string, unknown>[], hostId: string) {
  return new RemoteControlCloudClient({
    baseUrl: "https://cloud.example",
    authToken: "owner-token",
    request: async (url) => {
      expect(new URL(url).searchParams.get("hostId")).toBe(hostId);
      return Response.json({ success: true, data: { sessions } });
    },
  });
}

describe("remote control cloud client host sessions", () => {
  it("lists the active session next to a pairing a controller has claimed or is activating", async () => {
    const hostId = randomUUID(),
      ownerId = randomUUID();
    const active = cloudSession(hostId, ownerId, "active");
    const claimed = cloudSession(hostId, ownerId, "claimed");
    const activating = cloudSession(hostId, ownerId, "activating");
    const sessions = await listing(
      [claimed, activating, active],
      hostId,
    ).listSessions(hostId, ownerId);
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      [claimed.id, "claimed"],
      [activating.id, "activating"],
      [active.id, "active"],
    ]);
  });

  it("skips a target-created pairing challenge that no controller has claimed yet", async () => {
    const hostId = randomUUID(),
      ownerId = randomUUID();
    const challenge = cloudSession(hostId, ownerId, "pending", {
      deviceId: null,
      keyId: null,
    });
    const active = cloudSession(hostId, ownerId, "active");
    const sessions = await listing([challenge, active], hostId).listSessions(
      hostId,
      ownerId,
    );
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      [active.id, "active"],
    ]);
    await expect(
      listing([challenge], hostId).listSessions(hostId, randomUUID()),
    ).rejects.toThrow("session for a different owner");
  });

  it("still rejects a controller-bound session without a controller and an unknown status", async () => {
    const hostId = randomUUID(),
      ownerId = randomUUID();
    for (const status of ["claimed", "activating", "active"]) {
      await expect(
        listing(
          [
            cloudSession(hostId, ownerId, status, {
              deviceId: null,
              keyId: null,
            }),
          ],
          hostId,
        ).listSessions(hostId, ownerId),
      ).rejects.toThrow("invalid controller device id");
    }
    await expect(
      listing(
        [
          cloudSession(hostId, ownerId, "pending", {
            deviceId: "controller-device",
            keyId: null,
          }),
        ],
        hostId,
      ).listSessions(hostId, ownerId),
    ).rejects.toThrow("invalid controller key id");
    await expect(
      listing([cloudSession(hostId, ownerId, "paused")], hostId).listSessions(
        hostId,
        ownerId,
      ),
    ).rejects.toThrow("invalid session status");
  });
});

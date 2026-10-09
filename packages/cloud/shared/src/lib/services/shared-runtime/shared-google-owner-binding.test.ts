import { describe, expect, test } from "bun:test";
import { ChannelType } from "@elizaos/core";
import type { User } from "../../../db/schemas/users";
import { personalSharedAgent } from "./personal-shared-agent";
import { googlePersonalContextConsent } from "./shared-google-consent";
import { createOwnerBoundSharedGooglePort } from "./shared-google-owner-binding";
import { createSharedGoogleReadPort } from "./shared-google-read-port";

const GRANT = "11111111-1111-4111-8111-111111111111";
const agent = personalSharedAgent({ userId: "owner", organizationId: "org" });
const owner = (preferences: string | null) =>
  ({
    id: "owner",
    organization_id: "org",
    is_active: true,
    deleted_at: null,
    preferences,
  }) as User;

describe("Google owner/consent hosting", () => {
  test("wrong tenant and group channel cannot bind a private account", async () => {
    await expect(
      createOwnerBoundSharedGooglePort(agent, { type: ChannelType.GROUP }, async () => owner(null)),
    ).rejects.toThrow("SHARED_GOOGLE_PERSONAL_DM_REQUIRED");
    await expect(
      createOwnerBoundSharedGooglePort(agent, { type: ChannelType.DM }, async () => ({
        ...owner(null),
        organization_id: "other",
      })),
    ).rejects.toThrow("SHARED_GOOGLE_OWNER_CHANGED");
  });

  test("legacy and withdrawn personal-context preferences cannot dispatch a read", async () => {
    for (const preferences of [null, '{"googleConnected":true}', "{}"]) {
      const port = await createOwnerBoundSharedGooglePort(
        agent,
        { type: ChannelType.DM },
        async () => owner(preferences),
      );
      await expect(port.read({ kind: "gmail_search", query: "invoice" })).rejects.toThrow(
        "SHARED_GOOGLE_EXPLICIT_GRANT_REQUIRED",
      );
    }
  });

  test("withdrawn or reselected consent cannot authorize a previously bound read", async () => {
    let current = owner(
      JSON.stringify({
        personalGoogleContext: {
          ...googlePersonalContextConsent(),
          grantId: GRANT,
        },
      }),
    );
    const port = await createOwnerBoundSharedGooglePort(
      agent,
      { type: ChannelType.DM },
      async () => current,
    );
    current = owner("{}");
    await expect(port.read({ kind: "gmail_search", query: "invoice" })).rejects.toThrow(
      "SHARED_GOOGLE_PERSONAL_CONTEXT_CONSENT_REQUIRED",
    );
    current = owner(
      JSON.stringify({
        personalGoogleContext: {
          ...googlePersonalContextConsent(),
          grantId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    );
    await expect(port.read({ kind: "gmail_search", query: "invoice" })).rejects.toThrow(
      "SHARED_GOOGLE_PERSONAL_CONTEXT_CONSENT_REQUIRED",
    );
  });

  test("current grant revocation fails closed before provider data even with prior consent", async () => {
    let reads = 0;
    const deps: NonNullable<Parameters<typeof createSharedGoogleReadPort>[1]> = {
      initiateManagedGoogleConnection: async () => {
        throw new Error("NO_CONNECT");
      },
      getManagedGoogleConnectorStatus: async () => ({
        provider: "google",
        side: "owner",
        mode: "cloud_managed",
        configured: true,
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        expiresAt: null,
        hasRefreshToken: false,
        connectionId: GRANT,
        linkedAt: null,
        lastUsedAt: null,
      }),
      fetchManagedGoogleGmailSearch: async () => {
        reads += 1;
        throw new Error("NO_READ");
      },
      readManagedGoogleGmailMessage: async () => {
        reads += 1;
        throw new Error("NO_READ");
      },
      fetchManagedGoogleCalendarFeed: async () => {
        reads += 1;
        throw new Error("NO_READ");
      },
    };
    const port = await createOwnerBoundSharedGooglePort(
      agent,
      { type: ChannelType.DM },
      async () =>
        owner(
          JSON.stringify({
            personalGoogleContext: {
              ...googlePersonalContextConsent(),
              grantId: GRANT,
            },
          }),
        ),
      (scope) => createSharedGoogleReadPort(scope, deps),
    );
    await expect(port.read({ kind: "gmail_search", query: "invoice" })).rejects.toThrow(
      "SHARED_GOOGLE_READ_NOT_GRANTED",
    );
    expect(reads).toBe(0);
  });
});

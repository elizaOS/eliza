/**
 * Exercises owner-scoped browser companion revocation and native credential
 * expiry against the real PGlite repository across fresh service instances.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  type BrowserBridgeCompanionPairingResponse,
  createBrowserBridgeCompanionStatus,
  MAX_NATIVE_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS,
} from "@elizaos/plugin-browser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BrowserDomain,
  type BrowserDomainDeps,
} from "../src/lifeops/domains/browser-service.js";
import type { LifeOpsContext } from "../src/lifeops/lifeops-context.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let repository: LifeOpsRepository;

function browserDomain(ownerEntityId: string): BrowserDomain {
  const context = {
    runtime,
    repository,
    agentId: () => runtime.agentId,
    ownerEntityId: () => ownerEntityId,
  } as unknown as LifeOpsContext;
  const deps = {
    buildBrowserCompanion: (request, current) =>
      current
        ? {
            ...current,
            profileLabel: request.profileLabel ?? current.profileLabel,
            label: request.label,
            extensionVersion:
              request.extensionVersion ?? current.extensionVersion,
            updatedAt: new Date().toISOString(),
          }
        : createBrowserBridgeCompanionStatus({
            agentId: runtime.agentId,
            browser: request.browser,
            profileId: request.profileId,
            profileLabel: request.profileLabel,
            label: request.label,
            extensionVersion: request.extensionVersion,
            connectionState: request.connectionState,
            permissions: request.permissions,
            lastSeenAt: request.lastSeenAt,
            metadata: request.metadata,
          }),
  } satisfies Partial<BrowserDomainDeps>;
  return new BrowserDomain(context, deps as BrowserDomainDeps);
}

async function pair(
  ownerEntityId: string,
  profileId: string,
  browser: "chrome" | "firefox" | "safari" = "chrome",
): Promise<BrowserBridgeCompanionPairingResponse> {
  return await browserDomain(ownerEntityId).createBrowserCompanionPairing({
    browser,
    profileId,
    profileLabel: profileId,
    extensionVersion: "1.2.3",
    pairingKind: "native_enrollment",
  });
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  repository = new LifeOpsRepository(runtime);
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("browser companion revocation persistence", () => {
  it("enforces native TTL, survives restart, blocks reinstall identities, and requires owner reset", async () => {
    const ownerEntityId = "owner-revocation-a";
    const beforePairMs = Date.now();
    const initial = await pair(ownerEntityId, "profile-revoked");
    const afterPairMs = Date.now();
    const expiryMs = Date.parse(initial.pairingTokenExpiresAt ?? "");
    expect(expiryMs).toBeGreaterThan(beforePairMs);
    expect(expiryMs - afterPairMs).toBeLessThanOrEqual(
      MAX_NATIVE_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS,
    );
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(expiryMs + 1);
    await expect(
      browserDomain(ownerEntityId).requireBrowserCompanion(
        initial.companion.id,
        initial.pairingToken,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "browser_bridge_companion_token_expired",
    });
    dateNow.mockRestore();

    await browserDomain(ownerEntityId).revokeBrowserCompanion(
      initial.companion.id,
    );
    repository = new LifeOpsRepository(runtime);

    await expect(pair(ownerEntityId, "profile-revoked")).rejects.toMatchObject({
      status: 409,
      code: "revoked",
    });
    await expect(
      pair(ownerEntityId, "profile-after-reinstall"),
    ).rejects.toMatchObject({
      status: 409,
      code: "revoked",
    });
    await expect(
      pair(ownerEntityId, "profile-independent", "firefox"),
    ).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({
          profileId: "profile-independent",
          browser: "firefox",
        }),
      }),
    );

    await expect(
      browserDomain("different-owner").resetBrowserCompanionRevocation(
        initial.companion.id,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const reset = await browserDomain(
      ownerEntityId,
    ).resetBrowserCompanionRevocation(initial.companion.id);
    expect(reset.companion.pairingTokenRevokedAt).toBeNull();

    await expect(pair(ownerEntityId, "profile-revoked")).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({
          profileId: "profile-revoked",
          pairingTokenRevokedAt: null,
        }),
      }),
    );
    await expect(
      pair(ownerEntityId, "profile-after-reinstall"),
    ).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({
          profileId: "profile-after-reinstall",
        }),
      }),
    );
  });

  it("serializes pending-token promotion with revocation so revoke wins", async () => {
    const ownerEntityId = "owner-revocation-promotion-race";
    const active = await pair(ownerEntityId, "profile-promotion-race");
    const pending = await pair(ownerEntityId, "profile-promotion-race");

    await Promise.allSettled([
      browserDomain(ownerEntityId).requireBrowserCompanion(
        pending.companion.id,
        pending.pairingToken,
      ),
      browserDomain(ownerEntityId).revokeBrowserCompanion(active.companion.id),
    ]);

    repository = new LifeOpsRepository(runtime);
    await expect(
      browserDomain(ownerEntityId).requireBrowserCompanion(
        active.companion.id,
        active.pairingToken,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "browser_bridge_companion_token_revoked",
    });
    await expect(
      browserDomain(ownerEntityId).requireBrowserCompanion(
        pending.companion.id,
        pending.pairingToken,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "browser_bridge_companion_token_revoked",
    });
  });

  it("resets the browser-wide tombstone atomically across revoked profiles", async () => {
    const ownerEntityId = "owner-revocation-browser-reset";
    const profileA = await pair(ownerEntityId, "profile-reset-a");
    const profileB = await pair(ownerEntityId, "profile-reset-b");
    await browserDomain(ownerEntityId).revokeBrowserCompanion(
      profileA.companion.id,
    );
    await browserDomain(ownerEntityId).revokeBrowserCompanion(
      profileB.companion.id,
    );

    await browserDomain(ownerEntityId).resetBrowserCompanionRevocation(
      profileA.companion.id,
    );
    repository = new LifeOpsRepository(runtime);

    await expect(pair(ownerEntityId, "profile-reset-a")).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({ profileId: "profile-reset-a" }),
      }),
    );
    await expect(pair(ownerEntityId, "profile-reset-b")).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({ profileId: "profile-reset-b" }),
      }),
    );
    await expect(
      pair(ownerEntityId, "profile-reset-after-reinstall"),
    ).resolves.toEqual(
      expect.objectContaining({
        companion: expect.objectContaining({
          profileId: "profile-reset-after-reinstall",
        }),
      }),
    );
  });

  it("serializes pairing with revocation without resurrecting credentials", async () => {
    const ownerEntityId = "owner-revocation-pair-race";
    const active = await pair(ownerEntityId, "profile-pair-race");

    await Promise.allSettled([
      pair(ownerEntityId, "profile-pair-race"),
      browserDomain(ownerEntityId).revokeBrowserCompanion(active.companion.id),
    ]);

    repository = new LifeOpsRepository(runtime);
    await expect(
      pair(ownerEntityId, "new-install-profile-pair-race"),
    ).rejects.toMatchObject({ status: 409, code: "revoked" });
    await expect(
      browserDomain(ownerEntityId).requireBrowserCompanion(
        active.companion.id,
        active.pairingToken,
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "browser_bridge_companion_token_revoked",
    });
  });
});

/**
 * Writers that revoke credentials after their database commit. Nothing selects
 * those rows again, so these tests pin that one failed gate call cannot cost
 * another key its gate call or its cache invalidation.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { appsRepository } from "../../db/repositories/apps";
import { cliAuthSessionsRepository } from "../../db/repositories/cli-auth-sessions";
import { strandedAgentKeyRepository } from "../../db/repositories/stranded-agent-keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import { apiKeysService } from "./api-keys";
import { appsService } from "./apps";
import { cliAuthSessionsService } from "./cli-auth-sessions";
import {
  InferenceCredentialRevocationUnavailableError,
  settlePostCommitRevocations,
} from "./inference-credential-revocation";
import { sweepStrandedAgentKeys } from "./stranded-agent-key-sweeper";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const keyRow = (id: string) => ({ id, key_hash: `hash-${id}`, organization_id: ORG });

interface GateCall {
  path: string;
  body: Record<string, unknown>;
}

/** A gate that refuses the named credentials and records every request it receives. */
function gateRefusing(...refused: string[]) {
  const calls: GateCall[] = [];
  const stub = {
    async fetch(request: Request) {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path: new URL(request.url).pathname, body });
      const ok = !refused.includes(String(body.credentialId));
      return Response.json({ committed: ok }, { status: ok ? 200 : 503 });
    },
  };
  return {
    calls,
    revoked: () => calls.map((call) => call.body.credentialId),
    run: <T>(fn: () => Promise<T>) =>
      runWithCloudBindingsAsync(
        {
          VOICE_SPEECH_RELAY_ENABLED: "true",
          INFERENCE_ADMISSION_GATES: { getByName: () => stub },
        },
        fn,
      ),
  };
}

const spies: { mockRestore(): void }[] = [];
function spy<T extends { mockRestore(): void }>(created: T): T {
  spies.push(created);
  return created;
}

afterEach(() => {
  for (const created of spies.splice(0)) created.mockRestore();
});

function spyInvalidateCache() {
  return spy(spyOn(apiKeysService, "invalidateCache").mockResolvedValue(undefined));
}

describe("settlePostCommitRevocations", () => {
  test("attempts every item past one batch and groups rejected steps by item", async () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const attempted: number[] = [];

    const failures = await settlePostCommitRevocations(items, (item) => {
      attempted.push(item);
      return [
        item === 3 ? Promise.reject(new Error("gate")) : Promise.resolve(),
        item === 3 || item === 24 ? Promise.reject(new Error("cache")) : Promise.resolve(),
      ];
    });

    expect(attempted).toEqual(items);
    expect(failures.map(({ item, reasons }) => [item, reasons.length])).toEqual([
      [3, 2],
      [24, 1],
    ]);
  });
});

describe("CLI session reap", () => {
  test("revokes and invalidates every orphan key, then surfaces the failure", async () => {
    spy(
      spyOn(cliAuthSessionsRepository, "reapExpiredSessions").mockResolvedValue({
        deletedSessions: 3,
        revokedOrphanKeys: [keyRow("first"), keyRow("second"), keyRow("third")],
      }),
    );
    const invalidateCache = spyInvalidateCache();
    const gate = gateRefusing("first");

    await expect(
      gate.run(() => cliAuthSessionsService.cleanupExpiredSessions()),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);

    expect(gate.revoked()).toEqual(["first", "second", "third"]);
    expect(invalidateCache.mock.calls.map(([hash]) => hash)).toEqual([
      "hash-first",
      "hash-second",
      "hash-third",
    ]);
  });

  test("a cache failure on one key reaches the cron and spares the others", async () => {
    spy(
      spyOn(cliAuthSessionsRepository, "reapExpiredSessions").mockResolvedValue({
        deletedSessions: 2,
        revokedOrphanKeys: [keyRow("first"), keyRow("second")],
      }),
    );
    spy(
      spyOn(apiKeysService, "invalidateCache").mockImplementation(async (hash) => {
        if (hash === "hash-first") throw new Error("cache unavailable");
      }),
    );
    const gate = gateRefusing();

    await expect(gate.run(() => cliAuthSessionsService.cleanupExpiredSessions())).rejects.toThrow(
      "1/2",
    );
    expect(gate.revoked()).toEqual(["first", "second"]);
  });

  test("reports the reaped counts when the gate confirms every key", async () => {
    spy(
      spyOn(cliAuthSessionsRepository, "reapExpiredSessions").mockResolvedValue({
        deletedSessions: 4,
        revokedOrphanKeys: [keyRow("first")],
      }),
    );
    spyInvalidateCache();
    const gate = gateRefusing();

    await expect(gate.run(() => cliAuthSessionsService.cleanupExpiredSessions())).resolves.toEqual({
      deletedSessions: 4,
      revokedOrphanKeys: 1,
    });
    expect(gate.calls).toEqual([
      {
        path: "/credential/revoke",
        body: { organizationId: ORG, kind: "api_key", credentialId: "first" },
      },
    ]);
  });
});

describe("stranded agent key sweep", () => {
  test("still invalidates caches for every key when the gate refuses one", async () => {
    spy(
      spyOn(strandedAgentKeyRepository, "deleteOlderThan").mockResolvedValue([
        keyRow("first"),
        keyRow("second"),
      ] as never),
    );
    const invalidateCache = spyInvalidateCache();
    const gate = gateRefusing("first");

    await expect(gate.run(() => sweepStrandedAgentKeys(new Date()))).resolves.toBe(2);

    expect(gate.revoked()).toEqual(["first", "second"]);
    expect(invalidateCache.mock.calls.map(([hash]) => hash)).toEqual(["hash-first", "hash-second"]);
  });
});

describe("app deactivation", () => {
  test("offers every key to the gate and raises the failure for a retry", async () => {
    spy(spyOn(appsRepository, "findById").mockResolvedValue(undefined));
    spy(
      spyOn(appsRepository, "updateWithMobileAuthRevocation").mockResolvedValue({
        app: undefined,
        revokedKeyHashes: ["hash-first", "hash-second"],
        revokedKeys: [
          { id: "first", organizationId: ORG },
          { id: "second", organizationId: ORG },
        ],
      }),
    );
    const gate = gateRefusing("first");

    await expect(
      gate.run(() => appsService.update("app", { is_active: false })),
    ).rejects.toBeInstanceOf(InferenceCredentialRevocationUnavailableError);

    expect(gate.revoked().sort()).toEqual(["first", "second"]);
  });
});

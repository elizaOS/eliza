/**
 * `RemoteTargetDesktopService.resumeEligibleLoopback` — the decision that runs
 * after a desktop restart and decides whether this machine may resume acting
 * as a remote-control target.
 *
 * Its docstring states the invariant plainly: "Missing/corrupt credential or
 * journal state never degrades into a fresh enrollment or an unpinned runner."
 * That is a fail-closed security property, and none of it was asserted — the
 * two suites in this directory exercise the runner and the same-host
 * integration path, not this decision.
 *
 * Deterministic: the vault, journal, relay transport and clock are all
 * constructor-injected. `claimNext` returns nothing, so a resumed runner idles
 * instead of reaching the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteTargetDesktopService } from "./remote-target-rpc";
import type { RemoteTargetDurableState } from "./remote-target-store";
import {
  type RemoteTargetRelayTransport,
  RemoteTargetTransportError,
} from "./remote-target-transport";

const NOW = 1_800_000_000_000;
const API_BASE = "http://127.0.0.1:5173";
// The loopback executor refuses a token under 16 characters.
const API_TOKEN = "loopback-token-0123456789";

const services: RemoteTargetDesktopService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.stop().catch(() => undefined);
  }
});

type Session = RemoteTargetDurableState["sessions"][string];

/** A journal session that satisfies every "active authority" clause. */
function activeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    activationState: "active",
    stoppedAt: null,
    grant: { sessionId: "session-1", revokedAt: null, expiresAt: null },
    ...overrides,
  } as unknown as Session;
}

function stateWith(
  sessions: Record<string, Session>,
): RemoteTargetDurableState {
  return { version: 1, sessions, commands: {} } as RemoteTargetDurableState;
}

function makeService(options: {
  enrollment: unknown;
  state: RemoteTargetDurableState;
  commitActivation?: () => Promise<unknown>;
}): {
  service: RemoteTargetDesktopService;
  claimNext: ReturnType<typeof vi.fn>;
  state: RemoteTargetDurableState;
} {
  const state = options.state;
  const vault = {
    load: vi.fn(async () => options.enrollment),
  } as never;
  const stateStore = {
    read: vi.fn(async () => state),
    clear: vi.fn(async () => undefined),
    transact: vi.fn(
      async (operation: (s: RemoteTargetDurableState) => unknown) => {
        return await operation(state);
      },
    ),
  } as never;
  const claimNext = vi.fn(async () => null);
  const commitActivation = vi.fn(
    options.commitActivation ?? (async () => ({ ok: true })),
  );
  const transport = new Proxy(
    { claimNext, commitActivation },
    {
      get(target, prop) {
        // A Proxy get trap receives `string | symbol`, so the index type has
        // to admit both.
        if (prop in target)
          return (target as Record<string | symbol, unknown>)[prop];
        // Any other relay call in this path would be a surprise; make it loud.
        return async () => {
          throw new Error(`unexpected transport.${String(prop)}`);
        };
      },
    },
  ) as unknown as RemoteTargetRelayTransport;

  const service = new RemoteTargetDesktopService(
    vault,
    stateStore,
    transport,
    () => NOW,
  );
  services.push(service);
  return { service, claimNext, state };
}

function resume(service: RemoteTargetDesktopService) {
  return service.resumeEligibleLoopback({
    apiBase: API_BASE,
    apiToken: API_TOKEN,
  });
}

describe("no credentials means no resume", () => {
  it("reports not_enrolled when the vault is empty and nothing is active", async () => {
    const { service } = makeService({ enrollment: null, state: stateWith({}) });
    await expect(resume(service)).resolves.toEqual({
      resumed: false,
      reason: "not_enrolled",
    });
  });

  it("reports not_enrolled for a vault record that is not fully enrolled", async () => {
    // A half-written or superseded record must not be treated as authority.
    for (const status of ["pending", "revoked", "unknown"]) {
      const { service } = makeService({
        enrollment: { status },
        state: stateWith({}),
      });
      await expect(resume(service)).resolves.toEqual({
        resumed: false,
        reason: "not_enrolled",
      });
    }
  });

  it("THROWS when the journal holds a live grant but the credentials are gone", async () => {
    // This is the fail-closed case that matters. Returning `not_enrolled` here
    // would look like a clean first run and invite a fresh enrollment, quietly
    // orphaning a controller grant that is still live in the journal.
    const { service } = makeService({
      enrollment: null,
      state: stateWith({ "session-1": activeSession() }),
    });
    await expect(resume(service)).rejects.toThrow(
      /credentials are unavailable for the durable active session/i,
    );
  });
});

describe("enrolled, but nothing left to resume", () => {
  it("reports no_active_authority when every session is inert", async () => {
    const { service } = makeService({
      enrollment: { status: "enrolled" },
      state: stateWith({}),
    });
    await expect(resume(service)).resolves.toEqual({
      resumed: false,
      reason: "no_active_authority",
    });
  });

  it("leaves the runner STOPPED when there is no authority to act on", async () => {
    // `resumed: false` must also mean "not running". A runner started here
    // would poll the relay for commands with no grant backing it.
    const { service, claimNext } = makeService({
      enrollment: { status: "enrolled" },
      state: stateWith({}),
    });
    await resume(service);
    await expect(service.status()).resolves.toMatchObject({ running: false });
    expect(claimNext).not.toHaveBeenCalled();
  });

  it("a resumed decision leaves the runner RUNNING", async () => {
    const { service } = makeService({
      enrollment: { status: "enrolled" },
      state: stateWith({ "session-1": activeSession() }),
    });
    await expect(resume(service)).resolves.toEqual({
      resumed: true,
      reason: "active_authority",
    });
    await expect(service.status()).resolves.toMatchObject({ running: true });
  });
});

describe("every clause of the active-authority test", () => {
  async function resumeWith(overrides: Record<string, unknown>) {
    const { service } = makeService({
      enrollment: { status: "enrolled" },
      state: stateWith({ "session-1": activeSession(overrides) }),
    });
    return await resume(service);
  }

  it("resumes on a fully live session", async () => {
    await expect(resumeWith({})).resolves.toEqual({
      resumed: true,
      reason: "active_authority",
    });
  });

  it("a stopped session is not authority", async () => {
    await expect(resumeWith({ stoppedAt: NOW - 1_000 })).resolves.toEqual({
      resumed: false,
      reason: "no_active_authority",
    });
  });

  it("a revoked grant is not authority", async () => {
    await expect(
      resumeWith({ grant: { revokedAt: NOW - 1_000, expiresAt: null } }),
    ).resolves.toEqual({ resumed: false, reason: "no_active_authority" });
  });

  it("an expired grant is not authority", async () => {
    await expect(
      resumeWith({ grant: { revokedAt: null, expiresAt: NOW - 1 } }),
    ).resolves.toEqual({ resumed: false, reason: "no_active_authority" });
  });

  it("expiry is inclusive: a grant expiring exactly now still counts", async () => {
    // `expiresAt >= now`. The boundary decides whether a grant dies a
    // millisecond early on every restart.
    await expect(
      resumeWith({ grant: { revokedAt: null, expiresAt: NOW } }),
    ).resolves.toEqual({ resumed: true, reason: "active_authority" });
  });

  it("a null expiry never expires", async () => {
    await expect(
      resumeWith({ grant: { revokedAt: null, expiresAt: null } }),
    ).resolves.toEqual({ resumed: true, reason: "active_authority" });
  });
});

describe("a staged activation is resolved against the relay before deciding", () => {
  const staged = () =>
    stateWith({ "session-1": activeSession({ activationState: "staged" }) });

  it("a relay that CONFIRMS the commit promotes the session to active authority", async () => {
    // Recovery runs before the decision is read, so a confirmed commit is
    // indistinguishable from having been active all along — and should be.
    const { service, state } = makeService({
      enrollment: { status: "enrolled" },
      state: staged(),
    });
    await expect(resume(service)).resolves.toEqual({
      resumed: true,
      reason: "active_authority",
    });
    expect(state.sessions["session-1"]?.activationState).toBe("active");
  });

  it("a relay that reports the grant GONE drops it instead of resuming on it", async () => {
    // 404/409/410 mean the controller-side grant no longer exists. Coming up
    // on it would resume authority the relay has already retired.
    for (const status of [404, 409, 410]) {
      const { service, state } = makeService({
        enrollment: { status: "enrolled" },
        state: staged(),
        commitActivation: async () => {
          throw new RemoteTargetTransportError("gone", status);
        },
      });
      await expect(resume(service)).resolves.toEqual({
        resumed: false,
        reason: "no_active_authority",
      });
      expect(state.sessions["session-1"]).toBeUndefined();
    }
  });

  it("a relay OUTAGE leaves the grant staged and resumes as activation_recovery", async () => {
    // This is the only path to `activation_recovery`: the commit could not be
    // confirmed, so the runner comes up to keep retrying rather than either
    // discarding a real grant or claiming an authority it has not confirmed.
    for (const status of [0, 408, 429, 500, 503]) {
      const { service, state } = makeService({
        enrollment: { status: "enrolled" },
        state: staged(),
        commitActivation: async () => {
          throw new RemoteTargetTransportError("offline", status);
        },
      });
      await expect(resume(service)).resolves.toEqual({
        resumed: true,
        reason: "activation_recovery",
      });
      expect(state.sessions["session-1"]?.activationState).toBe("staged");
    }
  });

  it("an unclassified relay error propagates rather than guessing", async () => {
    // 401/403 are neither "gone" nor "offline". Silently choosing either would
    // discard a live grant or resume without authority.
    const { service } = makeService({
      enrollment: { status: "enrolled" },
      state: staged(),
      commitActivation: async () => {
        throw new RemoteTargetTransportError("forbidden", 403);
      },
    });
    await expect(resume(service)).rejects.toThrow(/HTTP 403/);
  });

  it("a stopped or revoked staged session is never committed at all", async () => {
    for (const overrides of [
      { activationState: "staged", stoppedAt: NOW - 1 },
      {
        activationState: "staged",
        grant: { sessionId: "session-1", revokedAt: NOW - 1, expiresAt: null },
      },
    ]) {
      const commitActivation = vi.fn(async () => ({ ok: true }));
      const { service } = makeService({
        enrollment: { status: "enrolled" },
        state: stateWith({ "session-1": activeSession(overrides) }),
        commitActivation,
      });
      await expect(resume(service)).resolves.toEqual({
        resumed: false,
        reason: "no_active_authority",
      });
      expect(commitActivation).not.toHaveBeenCalled();
    }
  });

  it("recovery is skipped entirely when the vault is not enrolled", async () => {
    const commitActivation = vi.fn(async () => ({ ok: true }));
    const { service } = makeService({
      enrollment: null,
      state: staged(),
      commitActivation,
    });
    await expect(resume(service)).resolves.toEqual({
      resumed: false,
      reason: "not_enrolled",
    });
    expect(commitActivation).not.toHaveBeenCalled();
  });
});

describe("configuration is serialized", () => {
  it("a rejected configuration does not poison the queue", async () => {
    // `enqueueConfiguration` swallows the tail's rejection precisely so one
    // failed configure cannot wedge every later one.
    const { service } = makeService({
      enrollment: null,
      state: stateWith({ "session-1": activeSession() }),
    });
    await expect(resume(service)).rejects.toThrow();
    await expect(resume(service)).rejects.toThrow();
  });

  it("concurrent resumes settle without interleaving", async () => {
    const { service } = makeService({
      enrollment: { status: "enrolled" },
      state: stateWith({}),
    });
    const results = await Promise.all([
      resume(service),
      resume(service),
      resume(service),
    ]);
    for (const result of results) {
      expect(result).toEqual({ resumed: false, reason: "no_active_authority" });
    }
  });
});

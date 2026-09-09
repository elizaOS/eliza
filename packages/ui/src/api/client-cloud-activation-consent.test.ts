/**
 * Exercises the actual Dedicated orchestration client with deterministic HTTP
 * receipts. No lifecycle request may precede a current-quote decision, including
 * recovery of an in-progress target; aborted or declined decisions cannot replay.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import type {
  DedicatedActivationConfirmationQuote,
  DedicatedActivationConfirmationRequester,
} from "./client-cloud";
import "./client-cloud";

const CLOUD_BASE = "https://api.eliza.app";
const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000020";
const JOB_ID = "10000000-0000-4000-8000-000000000020";
const UPGRADE_URL = `${CLOUD_BASE}/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`;
const QUOTE_ID = "a".repeat(64);

function quote(state: "available" | "in_progress" = "available") {
  return {
    quoteId: QUOTE_ID,
    quoteVersion: "personal-dedicated-v1",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    hourlyRateUsd: 0.01,
    dailyRateUsd: 0.24,
    minimumBalanceUsd: 0.72,
    minimumRunwayDays: 3,
    balanceUsd: 10,
    deficitUsd: 0,
    canActivate: true,
    requiresConfirmation: true,
    action: "activate_dedicated",
    activation:
      state === "available"
        ? { state }
        : { state, dedicatedAgentId: TARGET_ID, status: "running" },
  };
}

function transport(
  currentQuote: unknown = quote(),
  options: {
    rejectChangedQuote?: boolean;
    alreadyDedicated?: boolean;
    adoptionRequired?: boolean;
    adoptionTargetId?: string;
  } = {},
) {
  const mutations: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        mutations.push({ url, body: JSON.parse(String(init?.body)) });
      }
      if (url === `${CLOUD_BASE}/api/v1/eliza/personal`) {
        return Response.json({
          success: true,
          data: {
            identity: {
              id: PERSONAL_ID,
              displayName: "Eliza",
              runtime: options.alreadyDedicated ? "dedicated" : "shared",
              ...(options.alreadyDedicated
                ? {
                    activeAgentId: TARGET_ID,
                    apiBase: `https://${TARGET_ID}.cloud.eliza.app`,
                  }
                : {}),
            },
          },
        });
      }
      if (url === UPGRADE_URL && method === "GET") {
        return Response.json({ success: true, data: currentQuote });
      }
      if (url === UPGRADE_URL && method === "POST") {
        if (options.adoptionRequired) {
          return Response.json(
            { success: false, code: "dedicated_adoption_selection_required" },
            { status: 409 },
          );
        }
        if (options.rejectChangedQuote) {
          return Response.json(
            {
              success: false,
              code: "dedicated_quote_changed",
              data: { ...quote(), quoteId: "b".repeat(64) },
            },
            { status: 409 },
          );
        }
        return Response.json(
          {
            success: true,
            data: { dedicatedAgentId: TARGET_ID, jobId: JOB_ID },
          },
          { status: 202 },
        );
      }
      if (url === `${CLOUD_BASE}/api/v1/jobs/${JOB_ID}`) {
        return Response.json({
          success: true,
          data: { id: JOB_ID, status: "completed" },
        });
      }
      if (url === `${UPGRADE_URL}/adopt-existing` && method === "GET") {
        return Response.json({
          success: true,
          data: {
            ...quote(),
            quoteId: "b".repeat(64),
            action: "adopt_existing_dedicated",
            dedicatedAgentId: options.adoptionTargetId ?? TARGET_ID,
            adoptionState: "available",
            status: "stopped",
            startsCompute: true,
            stateDisposition: "verified_backup_present",
            canAdopt: true,
            requiresCatalogRestore: false,
          },
        });
      }
      if (url === `${UPGRADE_URL}/cutover`) {
        return Response.json({
          success: true,
          data: {
            personalElizaId: PERSONAL_ID,
            activeAgentId: TARGET_ID,
            runtime: "dedicated",
            apiBase: `https://${TARGET_ID}.cloud.eliza.app`,
            importedMessages: 0,
          },
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  );
  return mutations;
}

const options = {
  cloudApiBase: CLOUD_BASE,
  authToken: "test-session-token",
  pollIntervalMs: 0,
  timeoutMs: 1_000,
};

const confirm: DedicatedActivationConfirmationRequester = async (current) => ({
  action: "activate_dedicated",
  quoteId: current.quoteId,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Dedicated activation consent", () => {
  it("rejects a changed adoption target before asking for or dispatching adoption", async () => {
    const current = quote("in_progress");
    current.activation.status = "stopped";
    const mutations = transport(current, {
      adoptionTargetId: "00000000-0000-4000-8000-000000000021",
    });
    const request = vi.fn(async (review) => ({
      action: "adopt_existing_dedicated" as const,
      quoteId: review.quoteId,
    }));
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        ...options,
        requestDedicatedActivationConfirmation: confirm,
        requestDedicatedAdoptionConfirmation: request,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ADOPTION_TARGET_MISMATCH",
    });
    expect(request).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });
  it.each(["pending", "provisioning", "running"])(
    "confirms an existing %s target with the server before cutover",
    async (status) => {
      const current = quote("in_progress");
      current.activation.status = status;
      const mutations = transport(current);
      await new ElizaClient().ensurePersonalDedicatedEliza({
        ...options,
        requestDedicatedActivationConfirmation: confirm,
      });
      expect(mutations.map(({ url }) => url)).toEqual([
        UPGRADE_URL,
        `${UPGRADE_URL}/cutover`,
      ]);
      expect(mutations[0].body).toEqual({
        action: "activate_dedicated",
        quoteId: current.quoteId,
      });
    },
  );

  it.each(["pending", "provisioning", "running"])(
    "does not cut over an existing %s target when the server refuses the confirmation",
    async (status) => {
      const current = quote("in_progress");
      current.activation.status = status;
      const mutations = transport(current, { rejectChangedQuote: true });
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          ...options,
          requestDedicatedActivationConfirmation: confirm,
        }),
      ).rejects.toMatchObject({
        status: 409,
        data: { code: "dedicated_quote_changed" },
      });
      expect(mutations.map(({ url }) => url)).toEqual([UPGRADE_URL]);
    },
  );
  it("expires the decision itself before the longer startup deadline and ignores a late answer", async () => {
    vi.useFakeTimers();
    const current = quote();
    current.expiresAt = current.issuedAt + 200;
    const mutations = transport(current);
    let decide!: (value: {
      action: "activate_dedicated";
      quoteId: string;
    }) => void;
    let decisionSignal: AbortSignal | undefined;
    const request = vi.fn((_review, context) => {
      decisionSignal = context.signal;
      return new Promise<{ action: "activate_dedicated"; quoteId: string }>(
        (resolve) => {
          decide = resolve;
        },
      );
    });
    let settled = false;
    const outcome = new ElizaClient()
      .ensurePersonalDedicatedEliza({
        ...options,
        timeoutMs: 600_000,
        requestDedicatedActivationConfirmation: request,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({
      error: { message: expect.stringMatching(/expired/i) },
    });
    expect(decisionSignal?.aborted).toBe(true);
    decide({ action: "activate_dedicated", quoteId: QUOTE_ID });
    await Promise.resolve();
    expect(mutations).toEqual([]);
  });

  it.each(["available", "in_progress"] as const)(
    "refuses an expired %s quote before asking for consent",
    async (state) => {
      const current = quote(state);
      current.issuedAt -= 300_000;
      current.expiresAt = Date.now();
      const mutations = transport(current);
      const request = vi.fn(confirm);
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          ...options,
          requestDedicatedActivationConfirmation: request,
        }),
      ).rejects.toThrow(/expired/i);
      expect(request).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
    },
  );

  it("rejects confirmation when the quote expires during the decision", async () => {
    const current = quote();
    const mutations = transport(current);
    const clock = vi.spyOn(Date, "now");
    try {
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          ...options,
          timeoutMs: 600_000,
          requestDedicatedActivationConfirmation: async (review) => {
            clock.mockReturnValue(current.expiresAt);
            return { action: "activate_dedicated", quoteId: review.quoteId };
          },
        }),
      ).rejects.toThrow(/expired/i);
      expect(mutations).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["available", "in_progress"] as const)(
    "does not mutate a %s target when no current-quote decision is available",
    async (state) => {
      const mutations = transport(quote(state));
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza(options),
      ).rejects.toThrow(/confirm/i);
      expect(mutations).toEqual([]);
    },
  );

  it("waits for a decision showing the price and target state before one activation", async () => {
    const mutations = transport();
    let decide!: (
      value: { action: "activate_dedicated"; quoteId: string } | null,
    ) => void;
    const request = vi.fn(
      (_: DedicatedActivationConfirmationQuote) =>
        new Promise<{ action: "activate_dedicated"; quoteId: string } | null>(
          (resolve) => {
            decide = resolve;
          },
        ),
    );
    const attempt = new ElizaClient().ensurePersonalDedicatedEliza({
      ...options,
      requestDedicatedActivationConfirmation: request,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toMatchObject({
      hourlyRateUsd: 0.01,
      dailyRateUsd: 0.24,
      minimumBalanceUsd: 0.72,
      minimumRunwayDays: 3,
      balanceUsd: 10,
      activation: { state: "available" },
    });
    expect(mutations).toEqual([]);
    decide({ action: "activate_dedicated", quoteId: QUOTE_ID });
    await expect(attempt).resolves.toMatchObject({
      runtime: "dedicated",
      activeAgentId: TARGET_ID,
    });
    expect(mutations.map(({ url }) => url)).toEqual([
      UPGRADE_URL,
      `${UPGRADE_URL}/cutover`,
    ]);
    expect(mutations[0].body).toEqual({
      action: "activate_dedicated",
      quoteId: QUOTE_ID,
    });
  });

  it.each([
    null,
    { action: "activate_dedicated" as const, quoteId: "b".repeat(64) },
  ])(
    "does not execute a declined or mismatched decision: %j",
    async (decision) => {
      const mutations = transport();
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          ...options,
          requestDedicatedActivationConfirmation: async () => decision,
        }),
      ).rejects.toThrow(/confirm/i);
      expect(mutations).toEqual([]);
    },
  );

  it("aborts a pending decision and ignores its late confirmation", async () => {
    const mutations = transport();
    const controller = new AbortController();
    let decide!: (value: {
      action: "activate_dedicated";
      quoteId: string;
    }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ action: "activate_dedicated"; quoteId: string }>(
          (resolve) => {
            decide = resolve;
          },
        ),
    );
    const attempt = new ElizaClient().ensurePersonalDedicatedEliza({
      ...options,
      signal: controller.signal,
      requestDedicatedActivationConfirmation: request,
    });
    const outcome = attempt.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Entry superseded", "AbortError"));
    expect(await outcome).toMatchObject({
      error: { message: "Entry superseded" },
    });
    decide({ action: "activate_dedicated", quoteId: QUOTE_ID });
    await Promise.resolve();
    expect(mutations).toEqual([]);
  });

  it("returns a changed quote to the caller without automatically retrying its POST", async () => {
    const mutations = transport(quote(), { rejectChangedQuote: true });
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        ...options,
        requestDedicatedActivationConfirmation: confirm,
      }),
    ).rejects.toMatchObject({
      status: 409,
      data: { code: "dedicated_quote_changed" },
    });
    expect(mutations.map(({ url }) => url)).toEqual([UPGRADE_URL]);
  });

  it.each(["available", "pending", "provisioning"])(
    "cancels a redirected %s adoption decision without posting adoption or cutover",
    async (status) => {
      const current = quote(
        status === "available" ? "available" : "in_progress",
      );
      if (status !== "available") current.activation.status = status;
      const mutations = transport(current, { adoptionRequired: true });
      const controller = new AbortController();
      let decide!: (value: {
        action: "adopt_existing_dedicated";
        quoteId: string;
      }) => void;
      const requestAdoption = vi.fn(
        () =>
          new Promise<{ action: "adopt_existing_dedicated"; quoteId: string }>(
            (resolve) => {
              decide = resolve;
            },
          ),
      );
      const outcome = new ElizaClient()
        .ensurePersonalDedicatedEliza({
          ...options,
          signal: controller.signal,
          requestDedicatedActivationConfirmation: confirm,
          requestDedicatedAdoptionConfirmation: requestAdoption,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await vi.waitFor(() => expect(requestAdoption).toHaveBeenCalledTimes(1));
      controller.abort(new DOMException("Adoption cancelled", "AbortError"));
      expect(await outcome).toMatchObject({
        error: { message: "Adoption cancelled" },
      });
      decide({ action: "adopt_existing_dedicated", quoteId: "b".repeat(64) });
      await Promise.resolve();
      // The server rejected the explicitly confirmed generic request and asked
      // for the selected-row adoption; that second operation was never approved.
      expect(mutations.map(({ url }) => url)).toEqual([UPGRADE_URL]);
    },
  );

  it.each([
    { hourlyRateUsd: undefined },
    { dailyRateUsd: -1 },
    { quoteVersion: "unknown" },
    { requiresConfirmation: false },
    { activation: { state: "in_progress", status: "running" } },
  ])(
    "rejects an incomplete or invalid quote before requesting consent: %j",
    async (invalid) => {
      const mutations = transport({ ...quote(), ...invalid });
      const request = vi.fn(confirm);
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          ...options,
          requestDedicatedActivationConfirmation: request,
        }),
      ).rejects.toMatchObject({
        code: "CLOUD_DEDICATED_ACTIVATION_QUOTE_INVALID",
      });
      expect(request).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
    },
  );

  it("expires a pending decision and cannot execute a later confirmation", async () => {
    vi.useFakeTimers();
    const mutations = transport();
    let decide!: (value: {
      action: "activate_dedicated";
      quoteId: string;
    }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ action: "activate_dedicated"; quoteId: string }>(
          (resolve) => {
            decide = resolve;
          },
        ),
    );
    const outcome = new ElizaClient()
      .ensurePersonalDedicatedEliza({
        ...options,
        requestDedicatedActivationConfirmation: request,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(options.timeoutMs);
    expect(await outcome).toMatchObject({
      error: { message: expect.stringMatching(/deadline/) },
    });
    decide({ action: "activate_dedicated", quoteId: QUOTE_ID });
    await Promise.resolve();
    expect(mutations).toEqual([]);
  });

  it("does not reuse a previous invocation's confirmation on retry", async () => {
    const mutations = transport(quote("in_progress"));
    const client = new ElizaClient();
    await client.ensurePersonalDedicatedEliza({
      ...options,
      requestDedicatedActivationConfirmation: confirm,
    });
    expect(mutations.map(({ url }) => url)).toEqual([
      UPGRADE_URL,
      `${UPGRADE_URL}/cutover`,
    ]);
    mutations.length = 0;
    await expect(client.ensurePersonalDedicatedEliza(options)).rejects.toThrow(
      /confirm/i,
    );
    expect(mutations).toEqual([]);
  });

  it("reuses an already authoritative Dedicated runtime without asking to activate it", async () => {
    const mutations = transport(quote(), { alreadyDedicated: true });
    const request = vi.fn(confirm);
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        ...options,
        requestDedicatedActivationConfirmation: request,
      }),
    ).resolves.toMatchObject({
      runtime: "dedicated",
      activeAgentId: TARGET_ID,
    });
    expect(request).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });
});

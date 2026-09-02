/** Deterministic unit coverage for paid-provider admission and dispatch ordering. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const events: string[] = [];
const settledCosts: number[] = [];
let admissionError: Error | null = null;
let settleUnknown = mock(async () => {
  events.push("settleUnknown");
  return null;
});
const admitOrganizationInference = mock(async () => {
  events.push("admit");
  if (admissionError) throw admissionError;
  return {
    mode: "cache_admission",
    affiliateAttribution: null,
    markProviderDispatched: mock(async () => {
      events.push("mark");
    }),
    settle: mock(async (cost: number) => {
      events.push("settle");
      settledCosts.push(cost);
      return null;
    }),
    settleUnknown,
  };
});

mock.module("./organization-inference-admission", () => ({
  admitOrganizationInference,
}));

const {
  isGenerativeOperationAdmissionError,
  runFlatProviderOperation,
  runMeteredProviderOperation,
} = await import("./generative-operation");

const context = {
  organizationId: "org-1",
  userId: "user-1",
  apiKeyId: "key-1",
  requestId: "request-1",
};
const operation = {
  provider: "anthropic",
  billingSource: "anthropic" as const,
  model: "anthropic/test",
  operation: "test_generation",
  cost: 0.01,
};

beforeEach(() => {
  events.length = 0;
  settledCosts.length = 0;
  admissionError = null;
  settleUnknown = mock(async () => {
    events.push("settleUnknown");
    return null;
  });
});

describe("runFlatProviderOperation", () => {
  test("admits before marking and marks immediately before provider dispatch", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    await runFlatProviderOperation({ ...context, credential }, operation, async () => {
      events.push("provider");
      return "ok";
    });

    expect(events).toEqual(["admit", "mark", "provider", "settle"]);
    expect(admitOrganizationInference.mock.calls.at(-1)?.[0].credential).toBe(credential);
  });

  test("reuses one exact deferred credential across multiple atomic admissions", async () => {
    const credential = {
      kind: "api_key" as const,
      credentialId: "key-1",
      userId: "user-1",
    };
    const credentialForAdmission = mock(() => credential);
    const provider = mock(async () => "ok");
    const firstCall = admitOrganizationInference.mock.calls.length;

    await runFlatProviderOperation(
      { ...context, credential, credentialForAdmission },
      operation,
      provider,
    );
    await runFlatProviderOperation(
      { ...context, credential, credentialForAdmission },
      { ...operation, operation: "second_generation" },
      provider,
    );

    const admissions = admitOrganizationInference.mock.calls.slice(firstCall);
    expect(credentialForAdmission).toHaveBeenCalledTimes(2);
    expect(admissions).toHaveLength(2);
    expect(admissions.map(([params]) => params.credential)).toEqual([credential, credential]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["admit", "mark", "settle", "admit", "mark", "settle"]);
  });

  test("does not dispatch or mark when admission denies", async () => {
    admissionError = new Error("cached standing denied");
    const provider = mock(async () => "unexpected");

    let rejection: unknown;
    try {
      await runFlatProviderOperation(context, operation, provider);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(admissionError);
    expect(isGenerativeOperationAdmissionError(rejection)).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(events).toEqual(["admit"]);
  });

  test("settles unknown after a marked provider failure", async () => {
    await expect(
      runFlatProviderOperation(context, operation, async () => {
        events.push("provider");
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    expect(events).toEqual(["admit", "mark", "provider", "settleUnknown"]);
  });

  test("settles zero when marking fails before provider dispatch", async () => {
    const { admitOrganizationInference } = await import("./organization-inference-admission");
    (admitOrganizationInference as ReturnType<typeof mock>).mockImplementationOnce(async () => ({
      mode: "cache_admission",
      affiliateAttribution: null,
      markProviderDispatched: async () => {
        events.push("mark");
        throw new Error("mark failed");
      },
      settle: async (cost: number) => {
        events.push(`settle:${cost}`);
        return null;
      },
      settleUnknown,
    }));

    await expect(
      runFlatProviderOperation(context, operation, async () => "unexpected"),
    ).rejects.toThrow("mark failed");
    expect(events).toEqual(["mark", "settle:0"]);
  });
});

describe("runMeteredProviderOperation", () => {
  test("marks immediately before dispatch and settles the returned exact cost", async () => {
    const result = await runMeteredProviderOperation(
      context,
      { ...operation, estimatedCost: operation.cost },
      async () => {
        events.push("provider");
        return { value: "ok", actualCost: 0.004 };
      },
    );

    expect(result).toBe("ok");
    expect(events).toEqual(["admit", "mark", "provider", "settle"]);
    expect(settledCosts).toEqual([0.004]);
  });

  test("settles unknown when output parsing fails after dispatch", async () => {
    await expect(
      runMeteredProviderOperation(
        context,
        { ...operation, estimatedCost: operation.cost },
        async () => {
          events.push("provider");
          throw new Error("invalid provider output");
        },
      ),
    ).rejects.toThrow("invalid provider output");

    expect(events).toEqual(["admit", "mark", "provider", "settleUnknown"]);
  });
});

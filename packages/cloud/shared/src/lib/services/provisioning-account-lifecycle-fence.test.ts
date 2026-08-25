/** Proves provisioning preparation cannot cross a changed account lifecycle revision. */

import { describe, expect, mock, test } from "bun:test";
import { AccountLifecycleFencedError } from "./account-lifecycle-authority";
import {
  executeProvisioningWithAccountLifecycleAdmission,
  prepareProvisioningWithAccountLifecycleFence,
} from "./provisioning-account-lifecycle-fence";

const activeAuthority = {
  state: "active" as const,
  revision: 7,
  active: true,
  deletionRequestId: null,
};

describe("provisioning account lifecycle fence", () => {
  test("rechecks the captured revision after preparation", async () => {
    const order: string[] = [];
    const read = mock(async (_organizationId: string, revision?: number) => {
      order.push(revision === undefined ? "capture" : `recheck:${revision}`);
      return activeAuthority;
    });
    await prepareProvisioningWithAccountLifecycleFence(
      "10000000-0000-4000-8000-000000000001",
      async () => {
        order.push("prepare");
      },
      read,
    );
    expect(order).toEqual(["capture", "prepare", "recheck:7"]);
  });

  test("fails before preparation when deletion already owns authority", async () => {
    const prepare = mock(async () => undefined);
    const read = mock(async () => {
      throw new AccountLifecycleFencedError();
    });
    await expect(
      prepareProvisioningWithAccountLifecycleFence(
        "10000000-0000-4000-8000-000000000001",
        prepare,
        read,
      ),
    ).rejects.toBeInstanceOf(AccountLifecycleFencedError);
    expect(prepare).not.toHaveBeenCalled();
  });

  test("fails after preparation when deletion changes the revision", async () => {
    const prepare = mock(async () => undefined);
    const read = mock(async (_organizationId: string, revision?: number) => {
      if (revision === undefined) return activeAuthority;
      throw new AccountLifecycleFencedError();
    });
    await expect(
      prepareProvisioningWithAccountLifecycleFence(
        "10000000-0000-4000-8000-000000000001",
        prepare,
        read,
      ),
    ).rejects.toBeInstanceOf(AccountLifecycleFencedError);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test("does not enter the provider when deletion wins admission", async () => {
    const execute = mock(async () => "created");
    const release = mock(async () => undefined);
    await expect(
      executeProvisioningWithAccountLifecycleAdmission({
        authority: {
          organizationId: "10000000-0000-4000-8000-000000000001",
          operationKind: "agent_provision",
          operationId: "20000000-0000-4000-8000-000000000001",
        },
        execute,
        acquire: mock(async () => false),
        release,
      }),
    ).rejects.toBeInstanceOf(AccountLifecycleFencedError);
    expect(execute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test("holds admission through the provider call and releases exactly once", async () => {
    const order: string[] = [];
    const result = await executeProvisioningWithAccountLifecycleAdmission({
      authority: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        operationKind: "agent_provision",
        operationId: "20000000-0000-4000-8000-000000000001",
      },
      execute: async () => {
        order.push("provider");
        return "created";
      },
      acquire: mock(async () => {
        order.push("admitted");
        return true;
      }),
      release: mock(async () => {
        order.push("released");
      }),
    });
    expect(result).toBe("created");
    expect(order).toEqual(["admitted", "provider", "released"]);
  });

  test("keeps deletion fenced while provider resolution waits for durable settlement", async () => {
    let admissionLive = false;
    let resolveProvider: (() => void) | undefined;
    let resolveSettlement: (() => void) | undefined;
    const providerResolved = new Promise<void>((resolve) => {
      resolveProvider = resolve;
    });
    const settlementCommitted = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const activateDeletion = mock(async () =>
      admissionLive ? "provider_work_in_flight" : "activated",
    );

    const operation = executeProvisioningWithAccountLifecycleAdmission({
      authority: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        operationKind: "agent_provision",
        operationId: "20000000-0000-4000-8000-000000000001",
      },
      acquire: mock(async () => {
        admissionLive = true;
        return true;
      }),
      execute: async () => {
        resolveProvider?.();
        await settlementCommitted;
        return "durably-recorded";
      },
      release: mock(async () => {
        admissionLive = false;
      }),
    });

    await providerResolved;
    expect(await activateDeletion()).toBe("provider_work_in_flight");
    resolveSettlement?.();
    await expect(operation).resolves.toBe("durably-recorded");
    expect(await activateDeletion()).toBe("activated");
  });

  test("does not release admission when durable settlement fails", async () => {
    const release = mock(async () => undefined);
    await expect(
      executeProvisioningWithAccountLifecycleAdmission({
        authority: {
          organizationId: "10000000-0000-4000-8000-000000000001",
          operationKind: "agent_provision",
          operationId: "20000000-0000-4000-8000-000000000001",
        },
        acquire: mock(async () => true),
        execute: async () => {
          throw new Error("job receipt unavailable");
        },
        release,
      }),
    ).rejects.toThrow("job receipt unavailable");
    expect(release).not.toHaveBeenCalled();
  });
});

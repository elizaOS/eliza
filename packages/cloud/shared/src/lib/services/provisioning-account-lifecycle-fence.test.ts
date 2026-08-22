/** Proves provisioning preparation cannot cross a changed account lifecycle revision. */

import { describe, expect, mock, test } from "bun:test";
import { AccountLifecycleFencedError } from "./account-lifecycle-authority";
import { prepareProvisioningWithAccountLifecycleFence } from "./provisioning-account-lifecycle-fence";

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
});

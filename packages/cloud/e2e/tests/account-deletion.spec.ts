/** Exercises account-deletion request and isolation through the real local Worker route. */

import { seedTestUser } from "../src/fixtures/seed";
import { expect, test } from "../src/helpers/test-fixtures";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new Error(
    `Unsupported account-deletion snapshot value: ${typeof value}`,
  );
}

const REDACTED_EVIDENCE_VALUE = "[redacted]";
const SAFE_EVIDENCE_STRING_VALUES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  method: new Set(["DELETE", "GET", "PATCH", "POST"]),
  state: new Set(["active", "deactivated", "deleted"]),
};

function normalizedEvidenceField(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveEvidenceField(key: string): boolean {
  const normalized = normalizedEvidenceField(key);
  return (
    /(^|_)(?:id|identifier|email|phone|wallet|address|avatar|name|slug|description|preferences|settings)$/.test(
      normalized,
    ) ||
    /_(?:id|identifier|key|token|secret|credential|auth_tag|blind_index|ciphertext|nonce|hash|prefix|url)$/.test(
      normalized,
    ) ||
    normalized.startsWith("kms_") ||
    normalized.includes("_kms_")
  );
}

function redactDeletionAuthorityEvidence(
  value: CanonicalValue,
  field = "",
): CanonicalValue {
  if (typeof value === "string") {
    return SAFE_EVIDENCE_STRING_VALUES[field]?.has(value)
      ? value
      : REDACTED_EVIDENCE_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeletionAuthorityEvidence(entry, field));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveEvidenceField(key)
        ? REDACTED_EVIDENCE_VALUE
        : redactDeletionAuthorityEvidence(entry, key),
    ]),
  );
}

function assertPublishableDeletionEvidence(
  value: CanonicalValue,
  field = "",
): void {
  if (typeof value === "string") {
    if (
      value !== REDACTED_EVIDENCE_VALUE &&
      !SAFE_EVIDENCE_STRING_VALUES[field]?.has(value)
    ) {
      throw new Error(
        `Account-deletion evidence retained an unapproved string at ${field || "<root>"}`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertPublishableDeletionEvidence(entry, field);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    // Snapshot schemas use ordinary field identifiers. A dynamic path, ARN,
    // URL, UUID, or row identifier used as an object key is not publishable:
    // changing it to a placeholder could collide with another key and silently
    // discard evidence, so publication fails closed instead.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `Account-deletion evidence contained an unsafe structural key at ${key}`,
      );
    }
    assertPublishableDeletionEvidence(entry, key);
  }
}

function serializeDeletionAuthorityEvidence(value: CanonicalValue): string {
  const redacted = redactDeletionAuthorityEvidence(value);
  assertPublishableDeletionEvidence(redacted);
  return JSON.stringify(redacted, null, 2);
}

async function snapshotDeletionAuthority(stack: {
  mocks: {
    steward: {
      users: Map<string, string>;
      calls: Array<{ method: string; path: string; userId: string }>;
    };
  };
}): Promise<CanonicalValue> {
  const [
    { dbWrite },
    userSchema,
    organizationSchema,
    apiKeySchema,
    requestSchema,
  ] = await Promise.all([
    import("@elizaos/cloud-shared/db/helpers"),
    import("@elizaos/cloud-shared/db/schemas/users"),
    import("@elizaos/cloud-shared/db/schemas/organizations"),
    import("@elizaos/cloud-shared/db/schemas/api-keys"),
    import("@elizaos/cloud-shared/db/schemas/account-deletion-requests"),
  ]);
  const [userRows, organizationRows, apiKeyRows, requestRows] =
    await Promise.all([
      dbWrite.select().from(userSchema.users),
      dbWrite.select().from(organizationSchema.organizations),
      dbWrite.select().from(apiKeySchema.apiKeys),
      dbWrite.select().from(requestSchema.accountDeletionRequests),
    ]);
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((left, right) => left.id.localeCompare(right.id));

  return canonicalize({
    database: {
      users: byId(userRows),
      organizations: byId(organizationRows),
      apiKeys: byId(apiKeyRows),
      accountDeletionRequests: byId(requestRows),
    },
    steward: {
      userStates: [...stack.mocks.steward.users.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([userId, state]) => ({ userId, state })),
      calls: stack.mocks.steward.calls,
    },
  });
}

test.describe("account deletion", () => {
  test("fails closed without mutating the account or another tenant", async ({
    authenticatedPage,
    stack,
    seededUser,
  }, testInfo) => {
    const other = await seedTestUser({
      slug: `account-deletion-control-${Date.now()}`,
    });
    stack.mocks.steward.users.set(seededUser.stewardUserId, "active");
    stack.mocks.steward.users.set(other.stewardUserId, "active");
    const frontendEvents: Array<Record<string, unknown>> = [];
    authenticatedPage.on("console", (message) => {
      frontendEvents.push({
        type: `console:${message.type()}`,
        text: message.text(),
      });
    });
    authenticatedPage.on("pageerror", (error) => {
      frontendEvents.push({ type: "pageerror", text: error.message });
    });
    authenticatedPage.on("requestfailed", (request) => {
      frontendEvents.push({
        type: "requestfailed",
        method: request.method(),
        url: request.url(),
        error: request.failure()?.errorText,
      });
    });
    await authenticatedPage.goto(
      `${stack.urls.frontend}/account-deletion?requested=untrusted-receipt`,
    );
    await expect(
      authenticatedPage.getByRole("heading", {
        name: "Delete your account and data",
      }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("heading", { name: "Deletion scheduled" }),
    ).toHaveCount(0);
    const httpEvidence: Array<Record<string, unknown>> = [];
    const request = async (method: "GET" | "POST", confirmation?: string) => {
      const result = await authenticatedPage.evaluate(
        async ({ method, confirmation }) => {
          const response = await fetch("/api/v1/me/account-deletion", {
            method,
            headers: { "content-type": "application/json" },
            body:
              confirmation === undefined
                ? undefined
                : JSON.stringify({ confirmation }),
          });
          return { status: response.status, body: await response.json() };
        },
        { method, confirmation },
      );
      httpEvidence.push({ method, confirmation, ...result });
      return result;
    };

    const initial = await request("GET");
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message:
        "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
    });

    const trigger = authenticatedPage.getByTestId("delete-account-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveText("Deletion unavailable");

    const { accountDeletionRequestsRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/account-deletion-requests"
    );
    const authorityBefore = await snapshotDeletionAuthority(stack);
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        other.userId,
        true,
      ),
    ).toBeUndefined();

    const unconfirmed = await request("POST", "delete");
    expect(unconfirmed).toEqual({
      status: 400,
      body: {
        error: "Type DELETE to confirm permanent account deletion",
        code: "confirmation_required",
      },
    });
    const authorityAfterUnconfirmed = await snapshotDeletionAuthority(stack);
    expect(authorityAfterUnconfirmed).toEqual(authorityBefore);
    expect(stack.mocks.steward.calls).toEqual([]);

    const refused = await request("POST", "DELETE");
    expect(refused).toEqual({
      status: 409,
      body: {
        error:
          "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
        code: "LIFECYCLE_RESERVATION_REQUIRED",
      },
    });
    const authorityAfterConfirmedRefusal =
      await snapshotDeletionAuthority(stack);
    expect(authorityAfterConfirmedRefusal).toEqual(authorityBefore);
    expect(stack.mocks.steward.calls).toEqual([]);
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        seededUser.userId,
        true,
      ),
    ).toBeUndefined();
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(
        other.userId,
        true,
      ),
    ).toBeUndefined();

    const after = await request("GET");
    expect(after).toEqual(initial);
    expect(
      frontendEvents.filter(
        (event) => event.type === "pageerror" || event.type === "requestfailed",
      ),
    ).toEqual([]);
    expect(
      frontendEvents.filter((event) => event.type === "console:error"),
    ).toEqual([
      {
        type: "console:error",
        text: "Failed to load resource: the server responded with a status of 400 (Bad Request)",
      },
      {
        type: "console:error",
        text: "Failed to load resource: the server responded with a status of 409 (Conflict)",
      },
    ]);

    await testInfo.attach("account-deletion-authority-before.json", {
      body: serializeDeletionAuthorityEvidence(authorityBefore),
      contentType: "application/json",
    });
    await testInfo.attach("account-deletion-authority-after-unconfirmed.json", {
      body: serializeDeletionAuthorityEvidence(authorityAfterUnconfirmed),
      contentType: "application/json",
    });
    await testInfo.attach(
      "account-deletion-authority-after-confirmed-refusal.json",
      {
        body: serializeDeletionAuthorityEvidence(
          authorityAfterConfirmedRefusal,
        ),
        contentType: "application/json",
      },
    );
    await testInfo.attach("account-deletion-http.json", {
      body: JSON.stringify(httpEvidence, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("account-deletion-frontend-events.json", {
      body: JSON.stringify(frontendEvents, null, 2),
      contentType: "application/json",
    });
  });

  test("canonical authority snapshots detect mutations and publish only structurally redacted evidence", () => {
    const source = {
      database: {
        users: [{ id: "user-1", preferences: { theme: "dark" } }],
        organizations: [{ id: "org-1", settings: { locale: "en" } }],
        apiKeys: [
          {
            id: "key-1",
            key_ciphertext: "secret",
            key_prefix: "eliz_fixture",
            usage_count: 0,
          },
        ],
        accountDeletionRequests: [],
      },
      steward: {
        userStates: [{ userId: "steward-1", state: "active" }],
        calls: [] as Array<{ method: string; path: string; userId: string }>,
      },
    };
    const before = canonicalize(source);

    source.database.organizations[0].settings.locale = "fr";
    expect(canonicalize(source)).not.toEqual(before);
    source.database.organizations[0].settings.locale = "en";
    source.database.apiKeys.push({
      id: "key-2",
      key_ciphertext: "other-secret",
      key_prefix: "eliz_fixture_2",
      usage_count: 0,
    });
    expect(canonicalize(source)).not.toEqual(before);
    source.database.apiKeys.pop();
    source.steward.calls.push({
      method: "PATCH",
      path: "/deactivate",
      userId: "steward-1",
    });
    expect(canonicalize(source)).not.toEqual(before);
    source.steward.calls.pop();
    source.steward.userStates[0].state = "deactivated";
    expect(canonicalize(source)).not.toEqual(before);
    expect(redactDeletionAuthorityEvidence(canonicalize(source))).toMatchObject(
      {
        database: {
          apiKeys: [
            {
              key_ciphertext: "[redacted]",
              key_prefix: "[redacted]",
            },
          ],
        },
        steward: {
          userStates: [{ userId: "[redacted]", state: "deactivated" }],
        },
      },
    );

    const adversarial = canonicalize({
      id: "row-user-1",
      row_id: "row-2",
      stewardUserId: "steward-user-3",
      kms_key_id: "arn:aws:kms:us-west-2:123:key/private",
      path: "/platform/users/steward-user-3/delete",
      note: "embedded row-user-1 and steward-user-3",
      method: "DELETE",
      state: "deactivated",
    });
    const published = serializeDeletionAuthorityEvidence(adversarial);
    expect(published).not.toContain("row-user-1");
    expect(published).not.toContain("row-2");
    expect(published).not.toContain("steward-user-3");
    expect(published).not.toContain("arn:aws:kms");
    expect(published).not.toContain("/platform/users/");
    expect(published).toContain('"method": "DELETE"');
    expect(published).toContain('"state": "deactivated"');

    expect(() =>
      serializeDeletionAuthorityEvidence(
        canonicalize({
          "arn:aws:kms:us-west-2:123:key/private": "embedded-secret",
        }),
      ),
    ).toThrow("unsafe structural key");
  });
});

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

const SENSITIVE_EVIDENCE_FIELDS = new Set([
  "anonymous_session_id",
  "avatar",
  "billing_email",
  "description",
  "discord_avatar_url",
  "discord_global_name",
  "discord_id",
  "discord_username",
  "email",
  "name",
  "nickname",
  "phone_number",
  "preferences",
  "settings",
  "slug",
  "steward_tenant_id",
  "steward_tenant_api_key",
  "steward_user_id",
  "stripe_customer_id",
  "stripe_default_payment_method",
  "stripe_payment_method_id",
  "telegram_first_name",
  "telegram_id",
  "telegram_photo_url",
  "telegram_username",
  "wallet_address",
  "whatsapp_id",
  "whatsapp_name",
  "work_function",
  "userId",
  "key_auth_tag",
  "key_ciphertext",
  "key_hash",
  "key_kms_key_id",
  "key_nonce",
  "key_prefix",
]);

const SENSITIVE_EVIDENCE_FIELD_SUFFIXES = [
  "_auth_tag",
  "_blind_index",
  "_ciphertext",
  "_nonce",
] as const;

function isSensitiveEvidenceField(key: string): boolean {
  return (
    SENSITIVE_EVIDENCE_FIELDS.has(key) ||
    SENSITIVE_EVIDENCE_FIELD_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

function redactDeletionAuthorityEvidence(
  value: CanonicalValue,
): CanonicalValue {
  if (Array.isArray(value)) return value.map(redactDeletionAuthorityEvidence);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveEvidenceField(key)
        ? "[redacted]"
        : redactDeletionAuthorityEvidence(entry),
    ]),
  );
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
    const refused = await request("POST", "DELETE");
    expect(refused).toEqual({
      status: 409,
      body: {
        error:
          "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
        code: "LIFECYCLE_RESERVATION_REQUIRED",
      },
    });

    const authorityAfter = await snapshotDeletionAuthority(stack);
    expect(authorityAfter).toEqual(authorityBefore);
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
      body: JSON.stringify(
        redactDeletionAuthorityEvidence(authorityBefore),
        null,
        2,
      ),
      contentType: "application/json",
    });
    await testInfo.attach("account-deletion-authority-after.json", {
      body: JSON.stringify(
        redactDeletionAuthorityEvidence(authorityAfter),
        null,
        2,
      ),
      contentType: "application/json",
    });
    await testInfo.attach("account-deletion-http.json", {
      body: JSON.stringify(httpEvidence, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("account-deletion-frontend-events.json", {
      body: JSON.stringify(frontendEvents, null, 2),
      contentType: "application/json",
    });
  });

  test("canonical authority snapshots detect nested, row-set, and provider-call mutations", () => {
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
  });
});

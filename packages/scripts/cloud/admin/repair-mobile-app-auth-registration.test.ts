import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  databaseFailureInvariant,
  diagnose,
  type RegistrationRepairClient,
  repairRegistrationTransaction,
} from "./repair-mobile-app-auth-registration.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const KEY_ID = "44444444-4444-4444-8444-444444444444";

interface FakeState {
  app?: {
    organization_id: string;
    created_by_user_id: string;
    api_key_id: string | null;
  };
  duplicateCount?: number;
  key?: { organization_id: string; user_id: string; active: boolean };
  failAfterMutation?: boolean;
}

class FakeClient implements RegistrationRepairClient {
  readonly statements: string[] = [];
  private snapshot?: FakeState;

  constructor(readonly state: FakeState) {}

  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("BEGIN")) {
      this.snapshot = structuredClone(this.state);
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      this.snapshot = undefined;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot) {
        for (const key of Object.keys(this.state) as Array<keyof FakeState>) {
          delete this.state[key];
        }
        Object.assign(this.state, structuredClone(this.snapshot));
      }
      this.snapshot = undefined;
      return { rows: [] };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM organizations AS org")) {
      return {
        rows: [
          {
            organization_active: true,
            owner_active: true,
            owner_matches_organization: true,
            owner_role: "owner",
          } as T,
        ],
      };
    }
    if (sql.startsWith("SELECT count(*)::integer AS count")) {
      return { rows: [{ count: this.state.duplicateCount ?? 0 } as T] };
    }
    if (sql.includes("FROM apps WHERE id")) {
      return { rows: this.state.app ? [this.state.app as T] : [] };
    }
    if (sql.includes("FROM api_keys WHERE id")) {
      return {
        rows: this.state.key
          ? [
              {
                organization_id: this.state.key.organization_id,
                user_id: this.state.key.user_id,
              } as T,
            ]
          : [],
      };
    }
    if (sql.startsWith("UPDATE api_keys")) {
      if (this.state.key) this.state.key.active = false;
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE apps")) {
      if (!this.state.app) throw new Error("missing fake app");
      this.state.app.api_key_id = String(values[3]);
      if (this.state.failAfterMutation)
        throw new Error("injected post-update failure");
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO apps")) {
      this.state.app = {
        organization_id: String(values[2]),
        created_by_user_id: String(values[3]),
        api_key_id: String(values[6]),
      };
      if (this.state.failAfterMutation)
        throw new Error("injected post-insert failure");
      return { rows: [] };
    }
    throw new Error(`Unhandled fake SQL: ${sql}`);
  }
}

describe("privacy-safe diagnosis", () => {
  test("classifies allow-listed SQLSTATE values and redacts other failures", () => {
    expect(databaseFailureInvariant({ code: "42703", detail: "secret" })).toBe(
      "database.42703",
    );
    expect(databaseFailureInvariant({ code: "28P01", detail: "secret" })).toBe(
      "database.connection_or_query",
    );
  });

  test("unwraps the database cause without exposing its message", async () => {
    const failure = new Error("wrapped", {
      cause: Object.assign(new Error("contains private database detail"), {
        code: "42P01",
      }),
    });
    await expect(
      diagnose("postgres://redacted", APP_ID, async () => {
        throw failure;
      }),
    ).rejects.toThrow("database.42P01");
  });
});

describe("registration repair transaction", () => {
  test("creates an absent canonical app and commits", async () => {
    const client = new FakeClient({});
    await repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID);
    expect(client.state.app?.organization_id).toBe(ORG_ID);
    expect(client.state.app?.created_by_user_id).toBe(OWNER_ID);
    expect(client.state.app?.api_key_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  test("revokes a current generated key, updates, and is idempotent", async () => {
    const client = new FakeClient({
      app: {
        organization_id: ORG_ID,
        created_by_user_id: OWNER_ID,
        api_key_id: KEY_ID,
      },
      key: { organization_id: ORG_ID, user_id: OWNER_ID, active: true },
    });
    await repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID);
    await repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID);
    expect(client.state.key?.active).toBe(false);
    expect(client.state.app?.api_key_id).toBe(KEY_ID);
    expect(client.statements.filter((sql) => sql === "COMMIT")).toHaveLength(2);
  });

  test("derives protected authority from an existing locked row", async () => {
    const client = new FakeClient({
      app: {
        organization_id: ORG_ID,
        created_by_user_id: OWNER_ID,
        api_key_id: null,
      },
    });
    await repairRegistrationTransaction(client, APP_ID);
    expect(client.state.app?.organization_id).toBe(ORG_ID);
    expect(client.state.app?.created_by_user_id).toBe(OWNER_ID);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });

  test("rejects ownership mismatch and rolls back", async () => {
    const client = new FakeClient({
      app: {
        organization_id: ORG_ID,
        created_by_user_id: APP_ID,
        api_key_id: null,
      },
    });
    await expect(
      repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID),
    ).rejects.toThrow("registration.explicit_ownership_match");
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });

  test("rejects a duplicate callback claimant and rolls back", async () => {
    const client = new FakeClient({ duplicateCount: 1 });
    await expect(
      repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID),
    ).rejects.toThrow("registration.unique_callback_owner");
    expect(client.state.app).toBeUndefined();
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });

  test("requires protected ownership only when the app row is absent", async () => {
    const client = new FakeClient({});
    await expect(repairRegistrationTransaction(client, APP_ID)).rejects.toThrow(
      "input.organization_id_for_creation",
    );
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });

  test("rolls back state after a post-insert mutation error", async () => {
    const client = new FakeClient({ failAfterMutation: true });
    await expect(
      repairRegistrationTransaction(client, APP_ID, ORG_ID, OWNER_ID),
    ).rejects.toThrow("database.connection_or_query");
    expect(client.state.app).toBeUndefined();
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });

  test("rolls back state after a post-update mutation error", async () => {
    const client = new FakeClient({
      app: {
        organization_id: ORG_ID,
        created_by_user_id: OWNER_ID,
        api_key_id: KEY_ID,
      },
      key: { organization_id: ORG_ID, user_id: OWNER_ID, active: true },
      failAfterMutation: true,
    });
    await expect(repairRegistrationTransaction(client, APP_ID)).rejects.toThrow(
      "database.connection_or_query",
    );
    expect(client.state.key?.active).toBe(true);
    expect(client.state.app?.api_key_id).toBe(KEY_ID);
    expect(client.statements.at(-1)).toBe("ROLLBACK");
  });
});

test("workflow binds protected ownership secrets, never dispatch inputs", () => {
  const workflow = readFileSync(
    new URL(
      "../../../../.github/workflows/mobile-app-auth-registration-admin.yml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(workflow).toContain("secrets.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID");
  expect(workflow).toContain("secrets.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID");
  expect(workflow).not.toContain("inputs.organization_id");
  expect(workflow).not.toContain("inputs.owner_user_id");
});

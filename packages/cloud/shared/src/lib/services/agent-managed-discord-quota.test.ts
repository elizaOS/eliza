/**
 * Transaction-trace proof for managed Discord gateway admission (#23003).
 *
 * PGlite serializes statements and therefore proves the observable quota
 * result but not the advisory-lock key or ordering. This focused boundary test
 * captures the real Drizzle SQL emitted by the transaction helper and pins the
 * sequence: deadlines -> org advisory lock -> primary balance -> scoped marker
 * recheck -> quota count -> insert.
 */

import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbTransaction } from "../../db/client";
import { ensureManagedDiscordGatewayInTransaction } from "./agent-managed-discord";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

describe("ensureManagedDiscordGatewayInTransaction", () => {
  test("orders the org lock before primary tier, scoped marker, quota, and insert", async () => {
    const events: string[] = [];
    const whereClauses: SQL[] = [];
    let selectNumber = 0;

    const execute = mock(async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      if (query.sql.includes("set_config")) {
        events.push("deadlines");
      } else if (query.sql.includes("pg_advisory_xact_lock")) {
        events.push("org-lock");
        expect(query.params).toContain(ORG_ID);
        expect(query.params).toContain("agent-create");
      }
      return { rows: [] };
    });

    const select = mock(() => {
      selectNumber += 1;
      const current = selectNumber;
      const chain = {
        from: () => chain,
        where: (clause: SQL) => {
          whereClauses.push(clause);
          return chain;
        },
        orderBy: () => chain,
        for: () => chain,
        limit: async () => {
          if (current === 1) {
            events.push("primary-balance");
            return [{ creditBalance: "0.500000" }];
          }
          events.push("gateway-marker");
          return [];
        },
        // biome-ignore lint/suspicious/noThenProperty: Drizzle's quota count is awaited at where().
        then: (resolve: (rows: Array<{ count: number }>) => unknown) => {
          events.push("quota-count");
          return resolve([{ count: 0 }]);
        },
      };
      return chain;
    });

    const values = mock((_input: Record<string, unknown>) => ({
      returning: mock(async () => {
        events.push("insert");
        return [
          {
            id: AGENT_ID,
            organization_id: ORG_ID,
            user_id: USER_ID,
            agent_config: {
              __agentManagedDiscordGateway: {
                mode: "shared-gateway",
                createdAt: "2026-08-20T00:00:00.000Z",
              },
            },
          },
        ];
      }),
    }));
    const insert = mock(() => ({
      values,
    }));

    const tx = { execute, select, insert } as unknown as DbTransaction;
    const result = await ensureManagedDiscordGatewayInTransaction(tx, {
      organizationId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.created).toBe(true);
    expect(result.sandbox.id).toBe(AGENT_ID);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]?.[0].execution_tier).toBe("shared");
    expect(events).toEqual([
      "deadlines",
      "org-lock",
      "primary-balance",
      "gateway-marker",
      "quota-count",
      "insert",
    ]);

    expect(whereClauses).toHaveLength(3);
    const marker = new PgDialect().sqlToQuery(whereClauses[1] as SQL);
    expect(marker.sql).toContain("organization_id");
    expect(marker.sql).toContain("agent_config");
    expect(marker.sql).toContain("'shared-gateway'");
    expect(marker.params).toContain(ORG_ID);
    expect(marker.params).toContain("__agentManagedDiscordGateway");
  });
});

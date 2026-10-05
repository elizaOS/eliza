/**
 * Exercises the eliza1 dashboard-alerts script's daily usage aggregate and the
 * report it drives against the real cloud schema. Integration harness: the
 * production migrations build a PGlite store that is served over the Postgres
 * wire protocol, so the script's own node-postgres pool runs the unmodified
 * query. Every seeded usage row is a valid int4 value while several daily sums
 * exceed int4, which is the case the query must survive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { loadDashboardInputs, tokenSumToNumber } from "./dashboard-alerts";

const SCRIPT = path.join(import.meta.dir, "dashboard-alerts.ts");
const CLOUD_SHARED = path.resolve(import.meta.dir, "../../shared");
const INT4_MAX = 2_147_483_647;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORGANIZATION_ID = randomUUID();

/** One day's rows; each token value fits the int4 `usage_records` columns. */
interface SeedDay {
  daysAgo: number;
  rows: number;
  inputTokens: number;
  outputTokens: number;
  costPerSide: string;
}

const SEED_DAYS: SeedDay[] = [
  {
    daysAgo: 4,
    rows: 1,
    inputTokens: 1_000_000_000,
    outputTokens: 500_000_000,
    costPerSide: "0.010000",
  },
  {
    daysAgo: 3,
    rows: 2,
    inputTokens: 1_500_000_000,
    outputTokens: 1_200_000_000,
    costPerSide: "0.020000",
  },
  {
    daysAgo: 2,
    rows: 6,
    inputTokens: INT4_MAX,
    outputTokens: INT4_MAX,
    costPerSide: "0.500000",
  },
];

let root: string;
let db: PGlite;
let server: PGLiteSocketServer;
let databaseUrl: string;

function noonUtcDaysAgo(daysAgo: number): Date {
  const day = new Date(Date.now() - daysAgo * DAY_MS);
  day.setUTCHours(12, 0, 0, 0);
  return day;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eliza1-dashboard-alerts-"));
  const dataDir = path.join(root, "pgdata");
  const migrate = Bun.spawnSync([process.execPath, "run", "db:migrate"], {
    cwd: CLOUD_SHARED,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_PATH: path.join(CLOUD_SHARED, "node_modules"),
      DATABASE_URL: `pglite://${dataDir}`,
      DISABLE_LOCAL_PGLITE_FALLBACK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (migrate.exitCode !== 0) {
    throw new Error(
      `db:migrate failed: ${migrate.stderr.toString().slice(-600)}`,
    );
  }

  db = await PGlite.create({ dataDir, extensions: { btree_gist, vector } });
  await db.query(
    "INSERT INTO organizations (id, name, slug, credit_balance) VALUES ($1, $2, $3, $4)",
    [ORGANIZATION_ID, "Int4 overflow org", `int4-${ORGANIZATION_ID}`, "1.00"],
  );
  for (const day of SEED_DAYS) {
    for (let row = 0; row < day.rows; row += 1) {
      await db.query(
        `INSERT INTO usage_records (
           organization_id, type, provider, input_tokens, output_tokens,
           input_cost, output_cost, is_successful, created_at
         ) VALUES ($1, 'chat', 'test-provider', $2, $3, $4, $4, true, $5)`,
        [
          ORGANIZATION_ID,
          day.inputTokens,
          day.outputTokens,
          day.costPerSide,
          noonUtcDaysAgo(day.daysAgo),
        ],
      );
    }
  }

  server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 8,
  });
  await server.start();
  databaseUrl = `postgresql://postgres@${server.getServerConn()}/postgres`;
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("eliza1 dashboard-alerts daily token sums (#29770)", () => {
  test("seeded rows are valid int4 values whose daily sums exceed int4", async () => {
    const { rows } = await db.query<{ day_input: string; day_output: string }>(
      `SELECT sum(input_tokens)::text AS day_input, sum(output_tokens)::text AS day_output
         FROM usage_records WHERE organization_id = $1
         GROUP BY date_trunc('day', created_at)
         ORDER BY date_trunc('day', created_at)`,
      [ORGANIZATION_ID],
    );
    expect(rows).toEqual([
      { day_input: "1000000000", day_output: "500000000" },
      { day_input: "3000000000", day_output: "2400000000" },
      { day_input: "12884901882", day_output: "12884901882" },
    ]);
    for (const day of SEED_DAYS) {
      expect(day.inputTokens).toBeLessThanOrEqual(INT4_MAX);
      expect(day.outputTokens).toBeLessThanOrEqual(INT4_MAX);
    }
  });

  test("the script's node-postgres query returns exact daily sums past int4", async () => {
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    };
    process.env.DATABASE_URL = databaseUrl;
    delete process.env.TEST_DATABASE_URL;
    try {
      const { historicalData, creditBalance } = await loadDashboardInputs(
        ORGANIZATION_ID,
        new Date(Date.now() - 30 * DAY_MS),
        new Date(),
      );
      expect(
        historicalData.map((point) => [
          point.totalRequests,
          point.inputTokens,
          point.outputTokens,
        ]),
      ).toEqual([
        [1, 1_000_000_000, 500_000_000],
        [2, 3_000_000_000, 2_400_000_000],
        [6, 6 * INT4_MAX, 6 * INT4_MAX],
      ]);
      expect(creditBalance).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("the CLI generates, persists, and records projection alerts from those sums", async () => {
    const evidenceDir = path.join(root, "evidence");
    const proc = Bun.spawn(
      [
        process.execPath,
        // Same source resolution as the script-test lane; no built packages needed.
        "--conditions=eliza-source",
        SCRIPT,
        "--organization-id",
        ORGANIZATION_ID,
        "--evidence-dir",
        evidenceDir,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: databaseUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const files = await readdir(evidenceDir);
    expect(files).toHaveLength(1);
    const evidence = JSON.parse(
      await readFile(path.join(evidenceDir, files[0]), "utf8"),
    );
    // Without --dashboard-url the render check is not attempted, so the gate
    // stays "fail"; the query, projections, and persistence must still succeed.
    expect({ exitCode, stdout, stderr, evidence }).toMatchObject({
      exitCode: 1,
      evidence: {
        gate: "dashboard_alerts",
        status: "fail",
        organizationId: ORGANIZATION_ID,
        projectionAlertsGenerated: 3,
        alertEventsPersisted: 3,
        renderVerification: {
          attempted: false,
          reason: "missing --dashboard-url",
        },
      },
    });
    expect(evidence.error).toBeUndefined();

    const { rows } = await db.query<{
      policy_id: string;
      severity: string;
      evidence: { historicalPoints: number; creditBalance: number };
    }>(
      `SELECT policy_id, severity, evidence FROM analytics_alert_events
        WHERE organization_id = $1 ORDER BY policy_id`,
      [ORGANIZATION_ID],
    );
    expect(rows.map((row) => row.policy_id)).toEqual([
      "high_cost_projection",
      "low_balance",
      "usage_spike_predicted",
    ]);
    expect(rows.map((row) => row.severity)).toEqual([
      "critical",
      "critical",
      "warning",
    ]);
    for (const row of rows) {
      expect(row.evidence.historicalPoints).toBe(3);
      expect(row.evidence.creditBalance).toBe(1);
    }
    expect(evidence.alertEventIds).toHaveLength(3);
  }, 60_000);
});

describe("tokenSumToNumber keeps JavaScript precision separate from bigint width", () => {
  test("accepts node-postgres int8 strings and numbers up to MAX_SAFE_INTEGER", () => {
    expect(tokenSumToNumber("3000000000", "input_tokens")).toBe(3_000_000_000);
    expect(tokenSumToNumber(12_884_901_882, "output_tokens")).toBe(
      12_884_901_882,
    );
    expect(
      tokenSumToNumber(String(Number.MAX_SAFE_INTEGER), "input_tokens"),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects bigint sums that a JavaScript number would round", () => {
    expect(() => tokenSumToNumber("9007199254740993", "input_tokens")).toThrow(
      "input_tokens daily sum 9007199254740993 is not an exact JavaScript safe integer",
    );
    expect(() =>
      tokenSumToNumber("9223372036854775807", "output_tokens"),
    ).toThrow("output_tokens daily sum 9223372036854775807");
  });
});

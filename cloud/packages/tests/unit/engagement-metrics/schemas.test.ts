/**
 * Engagement Metrics Schema Tests
 *
 * Validates that the daily_metrics and retention_cohorts Drizzle schemas
 * have the correct table names, column definitions, and index configuration.
 */

import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { dailyMetrics } from "@/db/schemas/daily-metrics";
import { retentionCohorts } from "@/db/schemas/retention-cohorts";

type PrimaryColumnMetadata = {
  primary: boolean;
};

describe("dailyMetrics schema", () => {
  const config = getTableConfig(dailyMetrics);

  test("table name is daily_metrics", () => {
    expect(getTableName(dailyMetrics)).toBe("daily_metrics");
  });

  test("has all required columns", () => {
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("date");
    expect(columnNames).toContain("platform");
    expect(columnNames).toContain("dau");
    expect(columnNames).toContain("new_signups");
    expect(columnNames).toContain("total_messages");
    expect(columnNames).toContain("messages_per_user");
    expect(columnNames).toContain("created_at");
  });

  test("id is a uuid primary key", () => {
    const idCol = config.columns.find((c) => c.name === "id")!;
    expect(idCol.dataType).toBe("string");
    expect((idCol as PrimaryColumnMetadata).primary).toBe(true);
    expect(idCol.hasDefault).toBe(true);
  });

  test("date column is not nullable", () => {
    const dateCol = config.columns.find((c) => c.name === "date")!;
    expect(dateCol.notNull).toBe(true);
  });

  test("platform column is nullable (for aggregate rows)", () => {
    const platformCol = config.columns.find((c) => c.name === "platform")!;
    expect(platformCol.notNull).toBe(false);
  });

  test("dau, new_signups, total_messages have default 0", () => {
    for (const name of ["dau", "new_signups", "total_messages"]) {
      const col = config.columns.find((c) => c.name === name)!;
      expect(col.hasDefault).toBe(true);
      expect(col.notNull).toBe(true);
    }
  });

  test("messages_per_user is numeric(10,2)", () => {
    const col = config.columns.find((c) => c.name === "messages_per_user")!;
    expect(col.columnType).toBe("PgNumeric");
    expect(col.hasDefault).toBe(true);
  });

  test("has a unique index on (date, platform)", () => {
    const idx = config.indexes.find((i) => i.config.name === "daily_metrics_date_platform_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
  });

  test("has a non-unique index on (date)", () => {
    const idx = config.indexes.find((i) => i.config.name === "daily_metrics_date_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBeFalsy();
  });
});

describe("retentionCohorts schema", () => {
  const config = getTableConfig(retentionCohorts);

  test("table name is retention_cohorts", () => {
    expect(getTableName(retentionCohorts)).toBe("retention_cohorts");
  });

  test("has all required columns", () => {
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("cohort_date");
    expect(columnNames).toContain("platform");
    expect(columnNames).toContain("cohort_size");
    expect(columnNames).toContain("d1_retained");
    expect(columnNames).toContain("d7_retained");
    expect(columnNames).toContain("d30_retained");
    expect(columnNames).toContain("updated_at");
  });

  test("id is a uuid primary key", () => {
    const idCol = config.columns.find((c) => c.name === "id")!;
    expect(idCol.dataType).toBe("string");
    expect((idCol as PrimaryColumnMetadata).primary).toBe(true);
    expect(idCol.hasDefault).toBe(true);
  });

  test("cohort_date column is not nullable", () => {
    const col = config.columns.find((c) => c.name === "cohort_date")!;
    expect(col.notNull).toBe(true);
  });

  test("platform column is nullable (for aggregate rows)", () => {
    const col = config.columns.find((c) => c.name === "platform")!;
    expect(col.notNull).toBe(false);
  });

  test("cohort_size is required", () => {
    const col = config.columns.find((c) => c.name === "cohort_size")!;
    expect(col.notNull).toBe(true);
  });

  test("d1/d7/d30 retained columns are nullable", () => {
    for (const name of ["d1_retained", "d7_retained", "d30_retained"]) {
      const col = config.columns.find((c) => c.name === name)!;
      expect(col.notNull).toBe(false);
    }
  });

  test("has a unique index on (cohort_date, platform)", () => {
    const idx = config.indexes.find(
      (i) => i.config.name === "retention_cohorts_cohort_platform_idx",
    );
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
  });
});

/**
 * Drizzle `customType` definitions for columns whose driver representation
 * doesn't match the app-level type: a JSON-encoded string stored as `jsonb`,
 * and a JS epoch-millis number stored as `timestamptz`.
 */
import { customType } from "drizzle-orm/pg-core";

/** Stores a JSON-encoded string value in a `jsonb` column. */
export const stringJsonb = customType<{ data: string; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value: string): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): string {
    return JSON.stringify(value);
  },
});

/** Stores a JS epoch-millis number as a `timestamptz` column. */
export const numberTimestamp = customType<{ data: number; driverData: string }>({
  dataType() {
    return "timestamptz";
  },
  toDriver(value: number): string {
    return new Date(value).toISOString();
  },
  fromDriver(value: string): number {
    return new Date(value).getTime();
  },
});

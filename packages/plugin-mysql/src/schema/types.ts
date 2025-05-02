import { customType } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm'; // Import sql

/**
 * Represents a custom type for converting a number to a timestamp string and vice versa.
 * @param {Object} options - The options for the custom type.
 * @param {Function} options.dataType - A function that returns the data type as "timestamp".
 * @param {Function} options.toDriver - A function that converts a number to a timestamp string using the Date object's toISOString method.
 * @param {Function} options.fromDriver - A function that converts a timestamp string to a number using the Date object's getTime method.
 * @returns {Object} - The custom type for number to timestamp conversion.
 */
export const numberTimestamp = customType<{ data: number; driverData: string }>({
  dataType() {
    return 'timestamp';
  },
  toDriver(value: number): string {
    // Convert number timestamp to Date object
    const date = new Date(value);
    // Get ISO string (UTC): YYYY-MM-DDTHH:mm:ss.sssZ
    const isoString = date.toISOString();
    // Format for MySQL: YYYY-MM-DD HH:mm:ss
    // Replace 'T' with space, take first 19 chars (removes .sssZ)
    return isoString.replace('T', ' ').slice(0, 19);
  },
  fromDriver(value: string): number {
    return new Date(value).getTime();
  },
});

/**
 * Custom Drizzle type for MySQL's native VECTOR(N) type.
 * - Represents VECTOR(N) in SQL.
 * - Expects/provides Buffer for the driver (mysql2) representing Float32Array.
 * - Maps to number[] in application code.
 */
export const mysqlVectorNative = customType<{
  data: number[]; // How we use it in JS/TS
  driverData: Buffer; // What mysql2 driver gives/expects for VECTOR
  config: { dimensions: number }; // Required config to generate SQL
  notNull: false;
  default: false;
}>({
  dataType(config) {
    if (!config?.dimensions) {
      throw new Error('Vector dimensions must be provided in config');
    }
    // Generates the SQL type string e.g., "VECTOR(384)"
    return `vector(${config.dimensions})`;
  },
  // map driver value (Array) -> number[]
  fromDriver(value: unknown): number[] {
    // Check if the received value is a valid array of numbers
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')) {
      return value as number[]; // Cast and return the array
    } else {
      // Return empty array if it's not a valid array (or handle error appropriately)
      return [];
    }
  },
  // map application number[] -> SQL fragment for VECTOR
  toDriver(value: number[]) {
    if (!Array.isArray(value) || value.length === 0) {
      // Return SQL NULL. Adjust if the column cannot be NULL.
      return sql`NULL`;
    }
    // Convert number[] to JSON string '[num1, num2, ...]'
    const vectorString = JSON.stringify(value);
    // Return the SQL fragment using MySQL's STRING_TO_VECTOR function
    return sql`STRING_TO_VECTOR(${vectorString})`;
  },
});

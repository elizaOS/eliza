/**
 * Snowflake ID Generator
 *
 * Generates unique IDs for training package entities.
 * Uses a simple timestamp-based approach.
 */

let counter = 0;

export async function generateSnowflakeId(): Promise<string> {
  const timestamp = Date.now();
  const currentCounter = counter++;
  if (counter > 999) counter = 0;

  // Format: timestamp (13 digits) + counter (3 digits)
  return `${timestamp}${currentCounter.toString().padStart(3, "0")}`;
}

/**
 * Type contract for the reserved-storage static scanner consumed by the UI
 * guard test.
 */

export interface RawReservedStorageWriter {
  file: string;
  line: number;
  op: string;
  key: string;
}

export function findRawReservedStorageWriters(): RawReservedStorageWriter[];

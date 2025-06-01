import { stringToUuid, validateUuid } from '../v2';
import { UUID as UUIDv1 } from './types';

/**
 * Represents a UUID string in the format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 * This is a v1 compatibility wrapper for v2 UUID
 */
export type UUID = UUIDv1;

/**
 * Helper function to safely cast a string to strongly typed UUID
 * Wraps V2's validateUuid function
 *
 * @param id The string UUID to validate and cast
 * @returns The same UUID with branded type information
 * @throws Error if the UUID format is invalid
 */
export function asUUID(id: string): UUID {
  const validUuid = validateUuid(id);
  if (!validUuid) {
    throw new Error(`Invalid UUID format: ${id}`);
  }
  return id.toLowerCase() as UUID;
}

/**
 * Generates a UUID from a string input
 * Wraps V2's stringToUuid function
 *
 * @param input The string to convert to a UUID
 * @returns A UUID generated from the input string
 */
export function generateUuidFromString(input: string): UUID {
  return stringToUuid(input);
}

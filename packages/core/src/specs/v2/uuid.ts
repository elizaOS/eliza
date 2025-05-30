import { z } from 'zod';
import { stringToUuid as coreStringToUuid, validateUuid as coreValidateUuid } from '../../utils';
import type { UUID } from './types';

export const uuidSchema = z.string().uuid() as z.ZodType<UUID>;

/**
 * Validate if the given value is a valid UUID.
 *
 * @param {unknown} value - The value to be validated.
 * @returns {UUID | null} The validated UUID value or null if validation fails.
 */
export function validateUuid(value: unknown): UUID | null {
  return coreValidateUuid(value);
}

/**
 * Converts a string or number to a UUID.
 *
 * @param {string | number} target - The string or number to convert to a UUID.
 * @returns {UUID} The UUID generated from the input target.
 * @throws {TypeError} Throws an error if the input target is not a string.
 */
export function stringToUuid(target: string | number): UUID {
  return coreStringToUuid(target);
}

/**
 * Defines a custom type UUID representing a universally unique identifier
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Helper function to safely cast a string to strongly typed UUID
 * @param id The string UUID to validate and cast
 * @returns The same UUID with branded type information
 */
export function asUUID(id: string): UUID {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid UUID format: ${id}`);
  }
  return id as UUID;
}

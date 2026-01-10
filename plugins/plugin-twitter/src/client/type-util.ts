/**
 * Defines a type that ensures a specified property in an object is
 * not nullable or undefined.
 * @template T - The type of the object.
 * @template K - The keyof type representing the keys of the object.
 * @param {T} T - The object type.
 * @param {K} K - The key type of the object.
 * @returns {Object} - Returns a new type that includes all properties of the
 * original object with the specified key set to be non-nullable.
 */
export type NonNullableField<T, K extends keyof T> = {
  [P in K]-?: T[P];
} & T;

/**
 * Checks if the specified field is defined in the object.
 *
 * @template T - The type of the object
 * @template K - The key of the field
 * @param {K} key - The key of the field to check
 * @returns {(value: T) => value is NonNullableField<T, K>} A function that checks if the field is defined
 */
export function isFieldDefined<T, K extends keyof T>(key: K) {
  return (value: T): value is NonNullableField<T, K> => isDefined(value[key]);
}

/**
 * Check if a value is defined (not null or undefined).
 * @template T
 * @param {T | null | undefined} value - The value to check.
 * @return {value is T} Returns true if the value is defined, false otherwise.
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

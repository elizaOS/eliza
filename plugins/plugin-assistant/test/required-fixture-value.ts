/** Fail at the fixture boundary when a test requires a concrete value. */
export function requiredFixtureValue<T>(value: T): NonNullable<T> {
  if (value == null) throw new Error("Missing required fixture value");
  return value;
}

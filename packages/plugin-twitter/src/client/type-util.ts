export type NonNullableField<T, K extends keyof T> = {
  [P in K]-?: T[P];
} & T;

export function isFieldDefined<T, K extends keyof T>(key: K) {
  return (value: T): value is NonNullableField<T, K> => isDefined(value[key]);
}

export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

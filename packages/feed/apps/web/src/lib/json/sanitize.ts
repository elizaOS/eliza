export function sanitizeForJson<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (input: unknown): unknown => {
    if (typeof input === 'bigint') {
      return input.toString();
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (Array.isArray(input)) {
      return input.map((item) => visit(item));
    }

    if (input && typeof input === 'object') {
      if (seen.has(input)) {
        return null;
      }
      seen.add(input);

      return Object.fromEntries(
        Object.entries(input).map(([key, nested]) => [key, visit(nested)])
      );
    }

    return input;
  };

  return visit(value) as T;
}

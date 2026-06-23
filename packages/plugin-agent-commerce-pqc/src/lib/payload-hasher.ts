import { createHash, timingSafeEqual } from 'crypto';

export class PayloadTooDeepError extends Error {
  constructor(depth: number) {
    super(`Payload nesting exceeds maximum depth of ${depth}`);
    this.name = 'PayloadTooDeepError';
  }
}

export class PayloadHasher {
  static hash(payload: unknown): string {
    return PayloadHasher.hashPayload(payload);
  }

  static verify(payload: unknown, storedHash: string): boolean {
    return PayloadHasher.verifyHash(payload, storedHash);
  }

  private static readonly MAX_STRINGIFY_DEPTH = 64;

  static stableStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    const helper = (val: unknown, depth: number): string => {
      if (depth > PayloadHasher.MAX_STRINGIFY_DEPTH) {
        throw new PayloadTooDeepError(PayloadHasher.MAX_STRINGIFY_DEPTH);
      }
      if (val === null || typeof val !== 'object') {
        return JSON.stringify(val);
      }
      if (seen.has(val)) {
        throw new Error('Circular reference detected in payload');
      }
      seen.add(val);
      if (Array.isArray(val)) {
        return '[' + val.map((v) => helper(v, depth + 1)).join(',') + ']';
      }
      const keys = Object.keys(val as Record<string, unknown>).sort();
      const pairs = keys.map(
        (k) =>
          JSON.stringify(k) +
          ': ' +
          helper((val as Record<string, unknown>)[k], depth + 1),
      );
      return '{' + pairs.join(',') + '}';
    };
    return helper(value, 0);
  }

  static hashPayload(payload: unknown): string {
    return createHash('sha256')
      .update(PayloadHasher.stableStringify(payload))
      .digest('hex');
  }

  static verifyHash(payload: unknown, storedHash: string): boolean {
    const computed = Buffer.from(PayloadHasher.hashPayload(payload));
    const expected = Buffer.from(storedHash);
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(computed, expected);
  }

  hashPayload(payload: unknown): string {
    return PayloadHasher.hashPayload(payload);
  }

  verifyHash(payload: unknown, storedHash: string): boolean {
    return PayloadHasher.verifyHash(payload, storedHash);
  }
}

/**
 * Type declarations for @sentry/bun so typecheck passes when the package
 * is not resolved (e.g. from repo root without hoisting). When installed,
 * the package's own types take precedence via the "types" field in
 * node_modules/@sentry/bun/package.json.
 *
 * Replacement path: use @types/sentry__bun if it appears, or contribute these
 * declarations upstream to DefinitelyTyped or Sentry's own repository.
 */
declare module "@sentry/bun" {
  export interface Scope {
    setTag(key: string, value: string): void;
    setContext(name: string, context: Record<string, unknown>): void;
  }

  export function init(options: {
    dsn?: string;
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
  }): void;
  export function setTag(key: string, value: string): void;
  export function withScope(callback: (scope: Scope) => void): void;
  export function captureException(exception: unknown): void;
  export function flush(timeout?: number): Promise<boolean>;
}

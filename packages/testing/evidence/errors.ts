/**
 * Typed errors for the evidence-bundle pipeline. This package is a leaf
 * certification tool that must run in minimal CI/vast containers, so it does
 * not depend on the framework runtime; `EvidenceError` mirrors the shape of
 * `ElizaError` (`packages/core/src/errors.ts`: `code`, `context`, preserved
 * `cause`) so throw sites stay machine-classifiable without pulling in
 * `@elizaos/core`. Validation failures at runtime boundaries (reading a
 * manifest from disk) surface as `EvidenceValidationError` carrying the exact
 * per-field issues — never a silently-repaired object (error-policy J3).
 */

/** Options accepted by the {@link EvidenceError} constructor. */
export interface EvidenceErrorOptions {
  /** Stable, grep-able classification key (e.g. `MANIFEST_INVALID`). */
  code: string;
  /** Underlying error being wrapped; preserved on `.cause`. */
  cause?: unknown;
  /** Structured, serializable context for logs. */
  context?: Record<string, unknown>;
}

/** Structured error with a classification `code` and preserved `cause` chain. */
export class EvidenceError extends Error {
  override readonly name: string = "EvidenceError";
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options: EvidenceErrorOptions) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = options.code;
    this.context = options.context;
    // Restore the prototype chain for reliable `instanceof` across the
    // transpiled ES target boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One concrete reason a value failed schema validation. */
export interface ValidationIssue {
  /** Dotted path into the offending value (e.g. `artifacts.3.sha256`). */
  path: string;
  message: string;
}

/**
 * Thrown when an untrusted value (manifest/meta read from disk, CLI input)
 * fails schema validation. Carries every issue so callers can report the full
 * failure instead of the first field encountered.
 */
export class EvidenceValidationError extends EvidenceError {
  override readonly name: string = "EvidenceValidationError";
  readonly issues: readonly ValidationIssue[];

  constructor(
    message: string,
    issues: readonly ValidationIssue[],
    options: EvidenceErrorOptions,
  ) {
    super(message, options);
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

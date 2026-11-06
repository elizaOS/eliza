/** Types for errors.mjs. */
export declare class NativeHostError extends Error {
  constructor(message: string, options?: { status?: number; code?: string });
  status: number | undefined;
  code: string | undefined;
}

/** A coded host task failure; `instanceof ElizaError` is true for it. */
export declare class TaskHostError extends NativeHostError {
  constructor(message: string, options: { code: string; status?: number });
  code: string;
}

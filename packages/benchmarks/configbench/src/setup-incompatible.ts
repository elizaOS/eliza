export const CONFIGBENCH_SETUP_INCOMPATIBLE = "CONFIGBENCH_SETUP_INCOMPATIBLE";

export class SetupIncompatibleError extends Error {
  readonly code = CONFIGBENCH_SETUP_INCOMPATIBLE;
  readonly setupIncompatible = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SetupIncompatibleError";
  }
}

export function setupIncompatible(
  message: string,
  options?: { cause?: unknown },
): SetupIncompatibleError {
  return new SetupIncompatibleError(message, options);
}

export function isSetupIncompatibleError(
  error: unknown,
): error is SetupIncompatibleError {
  return (
    error instanceof SetupIncompatibleError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === CONFIGBENCH_SETUP_INCOMPATIBLE)
  );
}

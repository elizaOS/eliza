/** Fixed process metadata only; never serialize child output or arbitrary error context. */
const SIGNALS = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGKILL',
  'SIGSEGV',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGSYS',
  'SIGXCPU',
  'SIGXFSZ',
] as const;
export interface WorkerTerminationDiagnostic {
  exitCode: number | null;
  signal: string | null;
  identity?: { pid: number; uid: number; startedAt: number };
}
export function workerTermination(
  exitCode: unknown,
  signal: unknown,
  identity?: unknown
): WorkerTerminationDiagnostic {
  const v = identity && typeof identity === 'object' ? (identity as Record<string, unknown>) : {};
  const trusted =
    Number.isSafeInteger(v.pid) &&
    Number(v.pid) > 0 &&
    Number(v.pid) <= 2147483647 &&
    Number.isSafeInteger(v.uid) &&
    Number(v.uid) >= 0 &&
    Number(v.uid) <= 2147483647 &&
    Number.isSafeInteger(v.startedAt) &&
    Number(v.startedAt) > 0 &&
    Number(v.startedAt) <= 8640000000000000
      ? { pid: Number(v.pid), uid: Number(v.uid), startedAt: Number(v.startedAt) }
      : undefined;
  return {
    ...(trusted ? { identity: trusted } : {}),
    exitCode:
      Number.isInteger(exitCode) && Number(exitCode) >= 0 && Number(exitCode) <= 255
        ? Number(exitCode)
        : null,
    signal:
      signal === null || signal === undefined
        ? null
        : typeof signal === 'string' && (SIGNALS as readonly string[]).includes(signal)
          ? signal
          : 'unrecognized',
  };
}
export function workerTerminationFromError(
  error: unknown
): WorkerTerminationDiagnostic | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'SMTHRS_RESULT_MISSING' ||
    !('context' in error)
  )
    return;
  const context = error.context;
  if (!context || typeof context !== 'object' || !('workerTermination' in context)) return;
  const value = context.workerTermination;
  if (!value || typeof value !== 'object' || !('exitCode' in value) || !('signal' in value)) return;
  return workerTermination(
    value.exitCode,
    value.signal,
    'identity' in value ? value.identity : undefined
  );
}

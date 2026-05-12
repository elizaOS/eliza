/**
 * Host-agnostic background scheduler interface.
 *
 * Concrete implementations:
 *  - CapacitorBgScheduler — wraps `@capacitor/background-runner` so
 *    iOS BGTaskScheduler and Android WorkManager drive the wake-up callback.
 *  - IntervalBgScheduler  — pure `setInterval` fallback for environments with
 *    no native scheduler (server, desktop, web).
 *
 * The wake-up callback is the single seam where the host invokes
 * `TaskService.runDueTasks()` on the runtime. Everything else (registration,
 * cancellation, lifecycle) is plumbing.
 */
export interface IBgTaskScheduler {
  /**
   * Register the OS-level (or interval) job that fires the wake callback.
   * Idempotent: a second call replaces the previous registration.
   */
  schedule(options: ScheduleOptions): Promise<void>;

  /**
   * Cancel the OS-level (or interval) job. Safe to call when no job is
   * scheduled.
   */
  cancel(): Promise<void>;

  /**
   * True after a successful `schedule()` and before `cancel()`.
   */
  isScheduled(): boolean;

  /**
   * Identifier for the underlying transport. Useful for diagnostics.
   */
  readonly kind: BgSchedulerKind;
}

export type BgSchedulerKind = 'capacitor' | 'interval' | 'noop';

export interface ScheduleOptions {
  /**
   * Stable label for the OS-level job. iOS BGTaskScheduler requires this match
   * the identifier registered in `Info.plist`.
   */
  label: string;

  /**
   * Minimum minutes between wake-ups. iOS treats this as advisory: the OS may
   * delay or coalesce wakes based on battery, network, and usage. Android
   * WorkManager honours it for periodic work but enforces a 15-minute floor.
   */
  minimumIntervalMinutes: number;

  /**
   * Invoked on every OS wake-up (or interval tick). Must complete before the
   * native runtime is suspended again — iOS gives roughly 30s, Android more.
   * The host is responsible for catching any thrown error; this interface
   * intentionally does not swallow.
   */
  onWake: () => Promise<void>;
}

/**
 * Service-type slug for `runtime.registerService`. A future plugin that wraps
 * a different background-execution backend (e.g. Tauri 2 mobile) can register
 * under the same slug; first-active-wins keeps the runtime single-rooted.
 */
export const BACKGROUND_RUNNER_SERVICE_TYPE = 'background_runner' as const;

/**
 * Boot-splash watchdog (issue #11030).
 *
 * The startup shell renders a "Booting up…" loading view
 * (`[data-testid="startup-shell-loading"]`, phase in `data-startup-phase`)
 * while the startup coordinator resolves a backend. When the coordinator can
 * never make progress — the real-device failure on #11030 was a poisoned
 * persisted runtime mode blocking every local-agent request — the splash used
 * to spin forever with no error and no way out.
 *
 * This watchdog observes the loading view from the app shell (it deliberately
 * does not reach into React state): while the splash stays mounted in the SAME
 * phase past that phase's deadline, it overlays a plain-DOM error surface with
 * the stuck phase, a Retry button (full reload — the only reset that reliably
 * clears wedged boot state), and a "Keep waiting" dismiss that re-arms the
 * timer. Any phase progress or splash unmount clears the overlay and resets
 * the clock.
 */

export const BOOT_SPLASH_SELECTOR = '[data-testid="startup-shell-loading"]';
export const BOOT_STUCK_OVERLAY_ID = "eliza-boot-stuck-overlay";

/**
 * Per-phase stuck deadlines. `starting-runtime` / `hydrating` cover the
 * on-device agent cold boot (bun engine + PGlite migrations + model warmup),
 * which legitimately takes minutes on phone hardware — match the native
 * `ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS` (300s) so the fallback never fires on a
 * slow-but-healthy first boot. The early phases (restoring-session,
 * resolving-target, polling-backend) only talk to storage + the health
 * endpoint; 90s without progress there means the boot is wedged.
 */
export const DEFAULT_BOOT_PHASE_DEADLINES_MS: Record<string, number> = {
  "starting-runtime": 300_000,
  hydrating: 300_000,
};
export const DEFAULT_BOOT_STUCK_DEADLINE_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface BootSplashWatchdogOptions {
  doc?: Document;
  now?: () => number;
  pollIntervalMs?: number;
  defaultDeadlineMs?: number;
  phaseDeadlinesMs?: Record<string, number>;
  /** Retry action; defaults to a full reload. */
  onRetry?: () => void;
  /** Test seam: observe overlay presentation. */
  onStuck?: (phase: string) => void;
  /** When false (default in constructor form), no interval is scheduled. */
  schedule?: boolean;
}

export interface BootSplashWatchdog {
  /** Evaluate the splash state once (called on an interval when scheduled). */
  tick(): void;
  dispose(): void;
}

export function deadlineForPhase(
  phase: string,
  phaseDeadlinesMs: Record<string, number>,
  defaultDeadlineMs: number,
): number {
  const deadline = phaseDeadlinesMs[phase];
  return typeof deadline === "number" && deadline > 0
    ? deadline
    : defaultDeadlineMs;
}

function renderStuckOverlay(
  doc: Document,
  phase: string,
  onRetry: () => void,
  onDismiss: () => void,
): HTMLElement {
  const overlay = doc.createElement("div");
  overlay.id = BOOT_STUCK_OVERLAY_ID;
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-live", "assertive");
  overlay.setAttribute("data-boot-stuck-phase", phase);
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;" +
    "background:rgba(20,10,5,0.82);color:#fff;font-family:var(--font-sans,system-ui,sans-serif);" +
    "padding:24px;text-align:center;";

  const panel = doc.createElement("div");
  panel.style.cssText =
    "max-width:22rem;display:flex;flex-direction:column;gap:12px;align-items:center;";

  const title = doc.createElement("div");
  title.textContent = "Startup is taking too long";
  title.style.cssText = "font-size:1.125rem;font-weight:600;";

  const detail = doc.createElement("div");
  detail.setAttribute("data-testid", "boot-stuck-detail");
  detail.textContent =
    `The app has been stuck starting up (phase: ${phase}). ` +
    "You can retry, or keep waiting if this device is still setting up.";
  detail.style.cssText = "font-size:0.875rem;opacity:0.85;line-height:1.4;";

  const buttonRow = doc.createElement("div");
  buttonRow.style.cssText = "display:flex;gap:10px;margin-top:4px;";

  const retryButton = doc.createElement("button");
  retryButton.type = "button";
  retryButton.setAttribute("data-testid", "boot-stuck-retry");
  retryButton.textContent = "Retry";
  retryButton.style.cssText =
    "background:#ef5a1f;color:#fff;border:0;border-radius:9999px;" +
    "padding:10px 22px;font-size:0.9375rem;font-weight:600;cursor:pointer;";
  retryButton.addEventListener("click", onRetry);

  const waitButton = doc.createElement("button");
  waitButton.type = "button";
  waitButton.setAttribute("data-testid", "boot-stuck-wait");
  waitButton.textContent = "Keep waiting";
  waitButton.style.cssText =
    "background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.45);" +
    "border-radius:9999px;padding:10px 18px;font-size:0.9375rem;cursor:pointer;";
  waitButton.addEventListener("click", onDismiss);

  buttonRow.append(retryButton, waitButton);
  panel.append(title, detail, buttonRow);
  overlay.append(panel);
  doc.body.appendChild(overlay);
  return overlay;
}

export function startBootSplashWatchdog(
  options: BootSplashWatchdogOptions = {},
): BootSplashWatchdog {
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  const defaultDeadlineMs =
    options.defaultDeadlineMs ?? DEFAULT_BOOT_STUCK_DEADLINE_MS;
  const phaseDeadlinesMs =
    options.phaseDeadlinesMs ?? DEFAULT_BOOT_PHASE_DEADLINES_MS;
  const onRetry =
    options.onRetry ??
    (() => {
      doc.defaultView?.location.reload();
    });

  let currentPhase: string | null = null;
  let phaseSince = now();
  let overlay: HTMLElement | null = null;
  let disposed = false;

  const removeOverlay = (): void => {
    overlay?.remove();
    overlay = null;
  };

  const tick = (): void => {
    if (disposed) return;
    const splash = doc.querySelector(BOOT_SPLASH_SELECTOR);
    if (!splash) {
      // Boot progressed past the splash (or it has not mounted yet).
      currentPhase = null;
      removeOverlay();
      return;
    }
    const phase = splash.getAttribute("data-startup-phase") ?? "unknown";
    if (phase !== currentPhase) {
      currentPhase = phase;
      phaseSince = now();
      removeOverlay();
      return;
    }
    if (overlay) return;
    const deadline = deadlineForPhase(
      phase,
      phaseDeadlinesMs,
      defaultDeadlineMs,
    );
    if (now() - phaseSince < deadline) return;
    overlay = renderStuckOverlay(doc, phase, onRetry, () => {
      // "Keep waiting": dismiss and re-arm the current phase's timer.
      phaseSince = now();
      removeOverlay();
    });
    options.onStuck?.(phase);
  };

  const interval =
    options.schedule === false
      ? null
      : doc.defaultView?.setInterval(
          tick,
          options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        );

  return {
    tick,
    dispose(): void {
      disposed = true;
      if (interval != null) doc.defaultView?.clearInterval(interval);
      removeOverlay();
    },
  };
}

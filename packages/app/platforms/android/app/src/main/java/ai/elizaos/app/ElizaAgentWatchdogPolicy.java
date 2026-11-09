package ai.elizaos.app;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure watchdog/restart decisions for {@link ElizaAgentService}.
 *
 * Keep this class free of Android framework calls so the service's crash-loop
 * limits and health interpretation can be exercised on real devices without
 * launching the heavyweight local agent process.
 */
final class ElizaAgentWatchdogPolicy {
    private ElizaAgentWatchdogPolicy() {}

    /** Matches the host bootstrap policy: these errors need intervention, not retry. */
    static boolean isTerminalStartupFailure(String fatal) {
        if (fatal == null) return false;
        String normalized = fatal.toLowerCase(java.util.Locale.ROOT);
        return normalized.contains("destructive migration blocked")
            || normalized.contains("eliza_pglite_data_dir_in_use")
            || normalized.contains("eliza_pglite_corrupt_data")
            || normalized.contains("eliza_pglite_manual_reset_required");
    }

    enum ProbeResult {
        OK,
        BUSY,
        DEAD,
    }

    /**
     * Consecutive BUSY probes (one per watchdog interval, so 3 x 600 s) after
     * which a live agent that never answers is replaced. BUSY normally means a
     * long native decode, which finishes in seconds on phones and in minutes on
     * emulated CPUs; a loop that has not answered for 30 minutes is wedged.
     */
    static final int BUSY_RESTART_TICKS = 3;
    /** Healthy time after which a crash no longer counts toward the restart limit. */
    static final long STABLE_UPTIME_MS = 300_000L;
    /** Refused socket connects in a row before the detached child is checked for absence. */
    static final int ABSENCE_REFUSALS = 2;

    static final class HealthDecision {
        final int unhealthyTicks;
        final int busyTicks;
        final boolean restartRequired;

        private HealthDecision(int unhealthyTicks, int busyTicks, boolean restartRequired) {
            this.unhealthyTicks = unhealthyTicks;
            this.busyTicks = busyTicks;
            this.restartRequired = restartRequired;
        }
    }

    static final class RestartDecision {
        final boolean allowed;
        final int nextRestartAttempts;
        final long delayMs;

        private RestartDecision(boolean allowed, int nextRestartAttempts, long delayMs) {
            this.allowed = allowed;
            this.nextRestartAttempts = nextRestartAttempts;
            this.delayMs = delayMs;
        }
    }

    static boolean isReadyHealthBody(String body) {
        if (body == null || body.trim().isEmpty()) return false;
        try {
            JSONObject json = new JSONObject(body);
            if (!json.optBoolean("ready", false)) return false;
            String runtime = json.optString("runtime", "");
            if (!runtime.isEmpty() && !"ok".equals(runtime)) return false;
            String agentState = json.optString("agentState", "");
            return agentState.isEmpty() || "running".equals(agentState);
        } catch (JSONException error) {
            return false;
        }
    }

    static HealthDecision evaluateHealthProbe(
        ProbeResult probe,
        int unhealthyTicks,
        int busyTicks,
        int failStrikes
    ) {
        if (probe == ProbeResult.OK) {
            return new HealthDecision(0, 0, false);
        }
        if (probe == ProbeResult.BUSY) {
            // No strike: the process is alive, usually inside a native call.
            // A run of BUSY with no OK in between still has a ceiling.
            int nextBusyTicks = busyTicks + 1;
            if (nextBusyTicks >= BUSY_RESTART_TICKS) {
                return new HealthDecision(0, 0, true);
            }
            return new HealthDecision(unhealthyTicks, nextBusyTicks, false);
        }

        int nextUnhealthyTicks = unhealthyTicks + 1;
        if (nextUnhealthyTicks >= failStrikes) {
            return new HealthDecision(0, 0, true);
        }
        return new HealthDecision(nextUnhealthyTicks, busyTicks, false);
    }

    /**
     * The restart budget resets only after {@link #STABLE_UPTIME_MS} of health,
     * so an agent that crashes shortly after every ready still reaches the limit.
     * {@code healthySinceMs} is 0 while the agent has not been healthy since its
     * last start or failure.
     */
    static int restartAttemptsAfterHealthy(int restartAttempts, long healthySinceMs, long nowMs) {
        if (healthySinceMs <= 0L || nowMs - healthySinceMs < STABLE_UPTIME_MS) {
            return restartAttempts;
        }
        return 0;
    }

    /**
     * A detached agent is proven gone only when its socket refused connects on
     * consecutive checks AND the child journaled for the current launch has no
     * live process. A timeout or an unready answer is never absence.
     */
    static boolean detachedAbsenceProven(
        int consecutiveRefusals,
        boolean childJournaled,
        boolean childAlive
    ) {
        return consecutiveRefusals >= ABSENCE_REFUSALS && childJournaled && !childAlive;
    }

    static RestartDecision nextRestart(int restartAttempts, int maxRestartAttempts) {
        if (restartAttempts >= maxRestartAttempts) {
            return new RestartDecision(false, restartAttempts, 0L);
        }
        long delayMs = 1000L * (1L << restartAttempts);
        return new RestartDecision(true, restartAttempts + 1, delayMs);
    }

    /**
     * True when {@code error} is Android 12+'s
     * {@code android.app.ForegroundServiceStartNotAllowedException}: the OS
     * restarted the sticky service with no foreground activity (e.g. after an
     * LMK kill) and then denied {@code startForeground()}. Matched by class
     * name so this policy class stays framework-free and the check is safe on
     * minSdk 26 runtimes where the class does not exist.
     */
    static boolean isForegroundStartDenial(Throwable error) {
        return error != null
            && "android.app.ForegroundServiceStartNotAllowedException"
                .equals(error.getClass().getName());
    }
}

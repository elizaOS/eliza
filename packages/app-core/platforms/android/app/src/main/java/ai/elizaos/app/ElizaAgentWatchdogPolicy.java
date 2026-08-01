/**
 * Pure watchdog and restart-state transitions for the Android agent service.
 * Keeping process and socket inspection outside this class makes the state
 * transitions independently testable.
 */
package ai.elizaos.app;

final class ElizaAgentWatchdogPolicy {
    private ElizaAgentWatchdogPolicy() {}

    enum ProbeResult {
        OK,
        BUSY,
        DEAD,
    }

    static final class HealthDecision {
        final int unhealthyTicks;
        final boolean restartRequired;
        final boolean resetRestartAttempts;

        private HealthDecision(
            int unhealthyTicks,
            boolean restartRequired,
            boolean resetRestartAttempts
        ) {
            this.unhealthyTicks = unhealthyTicks;
            this.restartRequired = restartRequired;
            this.resetRestartAttempts = resetRestartAttempts;
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

    static HealthDecision evaluateHealthProbe(
        ProbeResult probe,
        int unhealthyTicks,
        int failStrikes
    ) {
        if (probe == ProbeResult.OK) {
            return new HealthDecision(0, false, true);
        }
        if (probe == ProbeResult.BUSY) {
            return new HealthDecision(unhealthyTicks, false, false);
        }

        int nextUnhealthyTicks = unhealthyTicks + 1;
        if (nextUnhealthyTicks >= failStrikes) {
            return new HealthDecision(0, true, false);
        }
        return new HealthDecision(nextUnhealthyTicks, false, false);
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

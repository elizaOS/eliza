package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** JVM tests for the watchdog's restart ceilings and restart-budget reset. */
public class ElizaAgentWatchdogPolicyTest {
    private static final int STRIKES = 3;

    private static ElizaAgentWatchdogPolicy.HealthDecision tick(
            ElizaAgentWatchdogPolicy.ProbeResult probe, ElizaAgentWatchdogPolicy.HealthDecision previous) {
        return ElizaAgentWatchdogPolicy.evaluateHealthProbe(
            probe, previous == null ? 0 : previous.unhealthyTicks,
            previous == null ? 0 : previous.busyTicks, STRIKES);
    }

    @Test
    public void threeBusyProbesInARowRequireARestart() {
        ElizaAgentWatchdogPolicy.HealthDecision first = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, null);
        ElizaAgentWatchdogPolicy.HealthDecision second = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, first);
        ElizaAgentWatchdogPolicy.HealthDecision third = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, second);

        assertFalse(first.restartRequired);
        assertFalse(second.restartRequired);
        assertEquals(2, second.busyTicks);
        assertTrue(third.restartRequired);
        assertEquals(0, third.busyTicks);
    }

    @Test
    public void anOkProbeResetsTheBusyCount() {
        ElizaAgentWatchdogPolicy.HealthDecision busy = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY,
            tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, null));
        ElizaAgentWatchdogPolicy.HealthDecision ok = tick(ElizaAgentWatchdogPolicy.ProbeResult.OK, busy);
        ElizaAgentWatchdogPolicy.HealthDecision after = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, ok);

        assertEquals(0, ok.busyTicks);
        assertEquals(1, after.busyTicks);
        assertFalse(after.restartRequired);
    }

    @Test
    public void aDeadProbeDoesNotClearTheBusyRun() {
        ElizaAgentWatchdogPolicy.HealthDecision busy = tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY,
            tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, null));
        ElizaAgentWatchdogPolicy.HealthDecision dead = tick(ElizaAgentWatchdogPolicy.ProbeResult.DEAD, busy);

        assertEquals(2, dead.busyTicks);
        assertEquals(1, dead.unhealthyTicks);
        assertTrue(tick(ElizaAgentWatchdogPolicy.ProbeResult.BUSY, dead).restartRequired);
    }

    @Test
    public void restartAttemptsSurviveACrashThirtySecondsAfterReady() {
        long readyAt = 1_000_000L;
        int attempts = 0;
        // Ready, then crash 30 s later, five times over: the budget is never reset.
        for (int cycle = 0; cycle < 5; cycle++) {
            attempts = ElizaAgentWatchdogPolicy.restartAttemptsAfterHealthy(attempts, readyAt, readyAt + 30_000L);
            ElizaAgentWatchdogPolicy.RestartDecision restart = ElizaAgentWatchdogPolicy.nextRestart(attempts, 5);
            assertTrue(restart.allowed);
            attempts = restart.nextRestartAttempts;
            readyAt += 60_000L;
        }
        assertFalse(ElizaAgentWatchdogPolicy.nextRestart(attempts, 5).allowed);
    }

    @Test
    public void restartAttemptsResetOnlyAfterStableUptime() {
        long readyAt = 1_000_000L;
        assertEquals(3, ElizaAgentWatchdogPolicy.restartAttemptsAfterHealthy(
            3, readyAt, readyAt + ElizaAgentWatchdogPolicy.STABLE_UPTIME_MS - 1L));
        assertEquals(0, ElizaAgentWatchdogPolicy.restartAttemptsAfterHealthy(
            3, readyAt, readyAt + ElizaAgentWatchdogPolicy.STABLE_UPTIME_MS));
        // Not healthy since the last start: never reset.
        assertEquals(3, ElizaAgentWatchdogPolicy.restartAttemptsAfterHealthy(3, 0L, Long.MAX_VALUE));
    }

    @Test
    public void absenceNeedsRepeatedRefusalsAndADeadJournaledChild() {
        assertTrue(ElizaAgentWatchdogPolicy.detachedAbsenceProven(2, true, false));
        assertFalse(ElizaAgentWatchdogPolicy.detachedAbsenceProven(1, true, false));
        assertFalse(ElizaAgentWatchdogPolicy.detachedAbsenceProven(2, true, true));
        // No journaled child for this launch: nothing proves absence.
        assertFalse(ElizaAgentWatchdogPolicy.detachedAbsenceProven(5, false, false));
    }
}

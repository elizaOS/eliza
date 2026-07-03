package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.ForegroundServiceStartNotAllowedException;
import android.os.Build;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ElizaAgentWatchdogPolicyInstrumentedTest {

    @Test
    public void readyHealthBodyAcceptsOnlyRunningRuntime() {
        assertTrue(ElizaAgentWatchdogPolicy.isReadyHealthBody(
            "{\"ready\":true,\"runtime\":\"ok\",\"agentState\":\"running\"}"
        ));
        assertTrue(ElizaAgentWatchdogPolicy.isReadyHealthBody(
            "{\"ready\":true}"
        ));

        assertFalse(ElizaAgentWatchdogPolicy.isReadyHealthBody(
            "{\"ready\":false,\"runtime\":\"ok\",\"agentState\":\"running\"}"
        ));
        assertFalse(ElizaAgentWatchdogPolicy.isReadyHealthBody(
            "{\"ready\":true,\"runtime\":\"degraded\",\"agentState\":\"running\"}"
        ));
        assertFalse(ElizaAgentWatchdogPolicy.isReadyHealthBody(
            "{\"ready\":true,\"runtime\":\"ok\",\"agentState\":\"starting\"}"
        ));
        assertFalse(ElizaAgentWatchdogPolicy.isReadyHealthBody("not-json"));
    }

    @Test
    public void busyProbePreservesExistingStrikeCounter() {
        ElizaAgentWatchdogPolicy.HealthDecision decision =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.BUSY,
                2,
                3
            );

        assertEquals(2, decision.unhealthyTicks);
        assertFalse(decision.restartRequired);
        assertFalse(decision.resetRestartAttempts);
    }

    @Test
    public void okProbeClearsStrikesAndResetsBackoff() {
        ElizaAgentWatchdogPolicy.HealthDecision decision =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.OK,
                2,
                3
            );

        assertEquals(0, decision.unhealthyTicks);
        assertFalse(decision.restartRequired);
        assertTrue(decision.resetRestartAttempts);
    }

    @Test
    public void deadProbeRestartsOnlyAfterConfiguredStrikeThreshold() {
        ElizaAgentWatchdogPolicy.HealthDecision first =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                0,
                3
            );
        ElizaAgentWatchdogPolicy.HealthDecision second =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                first.unhealthyTicks,
                3
            );
        ElizaAgentWatchdogPolicy.HealthDecision third =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                second.unhealthyTicks,
                3
            );

        assertEquals(1, first.unhealthyTicks);
        assertFalse(first.restartRequired);
        assertEquals(2, second.unhealthyTicks);
        assertFalse(second.restartRequired);
        assertEquals(0, third.unhealthyTicks);
        assertTrue(third.restartRequired);
    }

    @Test
    public void restartPolicyUsesBoundedExponentialBackoff() {
        long[] expectedDelays = {1000L, 2000L, 4000L, 8000L, 16000L};

        int attempts = 0;
        for (long expectedDelay : expectedDelays) {
            ElizaAgentWatchdogPolicy.RestartDecision decision =
                ElizaAgentWatchdogPolicy.nextRestart(attempts, 5);
            assertTrue(decision.allowed);
            assertEquals(expectedDelay, decision.delayMs);
            assertEquals(attempts + 1, decision.nextRestartAttempts);
            attempts = decision.nextRestartAttempts;
        }

        ElizaAgentWatchdogPolicy.RestartDecision fatal =
            ElizaAgentWatchdogPolicy.nextRestart(attempts, 5);
        assertFalse(fatal.allowed);
        assertEquals(5, fatal.nextRestartAttempts);
        assertEquals(0L, fatal.delayMs);
    }

    @Test
    public void foregroundStartDenialMatchesOnlyTheAndroid12Denial() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // The real framework exception (API 31+): the exact throwable
            // Service.startForeground() raises on a denied background start.
            assertTrue(ElizaAgentWatchdogPolicy.isForegroundStartDenial(
                new ForegroundServiceStartNotAllowedException("denied")
            ));
        }

        // Plain IllegalStateException (the pre-31 startForeground failure
        // shape, and any unrelated state bug) must NOT be swallowed.
        assertFalse(ElizaAgentWatchdogPolicy.isForegroundStartDenial(
            new IllegalStateException(
                "Service.startForeground() not allowed due to mAllowStartForeground false"
            )
        ));
        assertFalse(ElizaAgentWatchdogPolicy.isForegroundStartDenial(
            new RuntimeException("unrelated")
        ));
        assertFalse(ElizaAgentWatchdogPolicy.isForegroundStartDenial(null));
    }
}

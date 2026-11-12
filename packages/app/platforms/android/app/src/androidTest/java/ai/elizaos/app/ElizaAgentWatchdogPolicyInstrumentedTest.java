package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ElizaAgentWatchdogPolicyInstrumentedTest {

    @Test
    public void persistentStorageFailuresRequireInterventionInsteadOfRestart() {
        assertTrue(ElizaAgentWatchdogPolicy.isTerminalStartupFailure(
            "startEliza-threw: Error: Destructive migration blocked for eliza"));
        for (String code : new String[] { "ELIZA_PGLITE_DATA_DIR_IN_USE",
                "ELIZA_PGLITE_CORRUPT_DATA", "ELIZA_PGLITE_MANUAL_RESET_REQUIRED" }) {
            assertTrue(ElizaAgentWatchdogPolicy.isTerminalStartupFailure(
                "startup failed [" + code + "]: storage requires intervention"));
        }
        assertFalse(ElizaAgentWatchdogPolicy.isTerminalStartupFailure(null));
        assertFalse(ElizaAgentWatchdogPolicy.isTerminalStartupFailure(""));
        assertFalse(ElizaAgentWatchdogPolicy.isTerminalStartupFailure("socket timeout"));
        assertFalse(ElizaAgentWatchdogPolicy.isTerminalStartupFailure("exit 137"));
    }

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
                0,
                3
            );

        assertEquals(2, decision.unhealthyTicks);
        assertEquals(1, decision.busyTicks);
        assertFalse(decision.restartRequired);
    }

    @Test
    public void okProbeClearsStrikesAndBusyTicks() {
        ElizaAgentWatchdogPolicy.HealthDecision decision =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.OK,
                2,
                2,
                3
            );

        assertEquals(0, decision.unhealthyTicks);
        assertEquals(0, decision.busyTicks);
        assertFalse(decision.restartRequired);
    }

    @Test
    public void deadProbeRestartsOnlyAfterConfiguredStrikeThreshold() {
        ElizaAgentWatchdogPolicy.HealthDecision first =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                0,
                0,
                3
            );
        ElizaAgentWatchdogPolicy.HealthDecision second =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                first.unhealthyTicks,
                0,
                3
            );
        ElizaAgentWatchdogPolicy.HealthDecision third =
            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                ElizaAgentWatchdogPolicy.ProbeResult.DEAD,
                second.unhealthyTicks,
                0,
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

    /** PID of this app's bun agent (its argv names the bundle), or -1. */
    private static int residentAgentPid() {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return -1;
        for (File entry : entries) {
            int pid;
            try {
                pid = Integer.parseInt(entry.getName());
            } catch (NumberFormatException notAProcess) {
                continue;
            }
            try {
                String cmdline = new String(Files.readAllBytes(new File(entry, "cmdline").toPath()),
                    StandardCharsets.UTF_8).replace('\0', ' ');
                if (cmdline.contains("agent-bundle.js") && !cmdline.contains("launch")) return pid;
            } catch (Exception unreadable) {
                // Another user's process or one that just exited.
            }
        }
        return -1;
    }

    private static String agentNotificationText(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (StatusBarNotification posted : manager.getActiveNotifications()) {
            if (posted.getId() == 2) {
                CharSequence text = posted.getNotification().extras.getCharSequence(Notification.EXTRA_TEXT);
                return text == null ? "" : text.toString();
            }
        }
        return null;
    }

    /**
     * Device acceptance for the detached-absence check: SIGKILL the running bun
     * child only, then expect a new child within 75 s and a notification that
     * stops claiming the agent is ready. Needs a running resident and an
     * explicit opt-in, since it kills the device's real agent.
     */
    @Test
    public void killedResidentChildIsReplacedAndNotReportedRunning() {
        Assume.assumeTrue("Explicit resident kill fixture required", "1".equals(
            InstrumentationRegistry.getArguments().getString("residentKillFixture")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        int victim = residentAgentPid();
        Assume.assumeTrue("A running resident agent is required", victim > 0);
        assertEquals("On-device agent ready", agentNotificationText(context));

        android.os.Process.sendSignal(victim, android.os.Process.SIGNAL_KILL);
        long deadline = SystemClock.elapsedRealtime() + 75_000L;
        boolean leftRunning = false;
        int replacement = -1;
        while (SystemClock.elapsedRealtime() < deadline) {
            String text = agentNotificationText(context);
            if (text != null && !"On-device agent ready".equals(text)) leftRunning = true;
            int current = residentAgentPid();
            if (current > 0 && current != victim) {
                replacement = current;
                if (leftRunning) break;
            }
            SystemClock.sleep(500L);
        }
        assertTrue("no replacement agent within 75 s", replacement > 0);
        assertTrue("the notification kept saying running after the agent died", leftRunning);
    }
}

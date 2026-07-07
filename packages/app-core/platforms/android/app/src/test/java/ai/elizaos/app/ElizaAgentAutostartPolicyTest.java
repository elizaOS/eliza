/**
 * Host-side coverage for the Android service boot gate that decides whether a
 * stock phone should spawn the bundled local agent before the renderer starts.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM unit tests for the stock-Android local-agent autostart policy (#14390).
 * Only two things may auto-start the bundled agent: a branded device (the
 * device IS the agent) or an explicit onboarding "local" choice on a device
 * that clears the RAM-tier floor. A fresh install (no persisted mode) never
 * auto-starts — onboarding owns the decision and the renderer starts the
 * service on demand through the Agent Capacitor plugin — and a persisted
 * "local" on a RAM-blocked device is refused instead of wedging boot.
 */
public class ElizaAgentAutostartPolicyTest {

    private static final boolean RAM_OK = true;
    private static final boolean RAM_BLOCKED = false;

    @Test
    public void brandedDevicesAlwaysStartTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, RAM_OK));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, RAM_BLOCKED));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "cloud", RAM_OK));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "remote-mac", RAM_BLOCKED));
    }

    @Test
    public void stockFreshInstallNeverAutoStarts() {
        // The runtime decision belongs to onboarding: with no persisted mode the
        // renderer must land in first-run, then start the service explicitly
        // once the user commits to the local runtime.
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, RAM_OK));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "", RAM_OK));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "   ", RAM_OK));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, RAM_BLOCKED));
    }

    @Test
    public void stockCloudModesStayCloudFirst() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud", RAM_OK));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud-hybrid", RAM_OK));
    }

    @Test
    public void stockExternalModesDoNotStartTheBundledAgent() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "remote-mac", RAM_OK));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "tunnel-to-mobile", RAM_OK));
    }

    @Test
    public void stockLocalModeStartsTheBundledAgentWhenRamAllows() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local", RAM_OK));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local ", RAM_OK));
    }

    @Test
    public void stockLocalModeIsRefusedBelowTheRamFloor() {
        // A persisted "local" survives reinstalls via Capacitor Preferences, so
        // a low-RAM device can carry one it can no longer honor — refusing here
        // is what keeps a 4 GB phone from wedging boot for the 180 s budget.
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local", RAM_BLOCKED));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local ", RAM_BLOCKED));
    }

    /**
     * Cold-boot-guard stamp trust: the stamp is only as alive as the child it
     * describes. No journaled start yet = launcher's first second, trust it; a
     * journaled child that is gone from /proc = the force-stop/LMK signature,
     * relaunch instead of shepherding a corpse (#15189).
     */
    @Test
    public void coldBootStampTrustFollowsChildLiveness() {
        assertTrue(ElizaAgentService.coldBootStampTrustworthy(false, false));
        assertTrue(ElizaAgentService.coldBootStampTrustworthy(false, true));
        assertTrue(ElizaAgentService.coldBootStampTrustworthy(true, true));
        assertFalse(ElizaAgentService.coldBootStampTrustworthy(true, false));
    }
}

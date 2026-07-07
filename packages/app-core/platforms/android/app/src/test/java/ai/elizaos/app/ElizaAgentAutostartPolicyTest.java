/**
 * Host-side coverage for the Android service boot gate that decides whether a
 * stock phone should spawn the bundled local agent before the renderer starts.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM unit tests for the stock-Android local-agent autostart policy. The gate
 * must mirror the renderer's pre-seed build truth (pre-seed-local-runtime.ts):
 * a build that ships the agent payload boots it even before onboarding records
 * a choice — the renderer already committed to it as the startup target, and
 * waiting for the persisted choice deadlocks the first-ever launch (#15189).
 * Builds without the payload (cloud-thinned Play Store, UI-only debug) stay
 * cloud-first, and an explicit non-local user choice is always respected.
 */
public class ElizaAgentAutostartPolicyTest {

    @Test
    public void brandedDevicesAlwaysStartTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, true));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, false));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "cloud", false));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "remote-mac", false));
    }

    @Test
    public void stockFreshInstallStartsTheAgentWhenTheBuildShipsIt() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, true));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "", true));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "   ", true));
    }

    @Test
    public void stockFreshInstallStaysCloudFirstWithoutThePayload() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, false));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "", false));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "   ", false));
    }

    @Test
    public void stockCloudModesStayCloudFirstEvenWithThePayload() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud", true));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud-hybrid", true));
    }

    @Test
    public void stockExternalModesDoNotStartTheBundledAgent() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "remote-mac", true));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "tunnel-to-mobile", true));
    }

    @Test
    public void stockLocalModeStartsTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local", true));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local ", false));
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

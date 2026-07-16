/**
 * Host-side coverage for the Android service boot gate that decides whether a
 * stock phone should spawn the bundled local agent before the renderer starts.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM unit tests for the stock-Android on-device-agent autostart policy (#14390,
 * #15577). Three things may auto-start the bundled agent: a branded device (the
 * device IS the agent); an explicit "local" choice on a device that clears the
 * 8 GB local floor; or an explicit "cloud-hybrid" choice on a device that clears
 * the lower 4 GB hybrid floor (cloud inference, but the on-device agent still
 * owns chat, plugins, the voice bridge, and device control). A fresh install (no
 * persisted mode) never auto-starts — onboarding owns the decision and the
 * renderer starts the service on demand through the Agent Capacitor plugin — and
 * a persisted on-device mode the device can no longer honor is refused instead
 * of wedging boot.
 */
public class ElizaAgentAutostartPolicyTest {

    // Marketed sizes recovered by DeviceRamTierPolicy (round raw totalMem UP to
    // the next whole GiB): a 6 GB LP3 phone clears the 4 GB hybrid floor but not
    // the 8 GB local floor, which is the exact case cloud-hybrid must handle.
    private static final long RAM_12GB = 12L * (1L << 30);
    private static final long RAM_6GB = 6L * (1L << 30);
    private static final long RAM_3GB = 3L * (1L << 30);

    @Test
    public void brandedDevicesAlwaysStartTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, RAM_12GB));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null, RAM_3GB));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "cloud", RAM_12GB));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "remote-mac", RAM_3GB));
    }

    @Test
    public void stockFreshInstallNeverAutoStarts() {
        // The runtime decision belongs to onboarding: with no persisted mode the
        // renderer must land in first-run, then start the service explicitly
        // once the user commits to a runtime — even on a device that clears both
        // RAM floors.
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, RAM_12GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "", RAM_12GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "   ", RAM_12GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null, RAM_3GB));
    }

    @Test
    public void stockPureCloudStaysCloudFirst() {
        // Pure cloud runs no on-device agent, regardless of RAM headroom.
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud", RAM_12GB));
    }

    @Test
    public void stockCloudHybridStartsTheBundledAgentWhenHybridRamAllows() {
        // cloud-hybrid needs the on-device agent and clears the lower 4 GB
        // hybrid floor — so a 6 GB LP3 (hybrid-OK, local-blocked) auto-starts,
        // and a phone below the hybrid floor does not.
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud-hybrid", RAM_6GB));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " cloud-hybrid ", RAM_6GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud-hybrid", RAM_3GB));
    }

    @Test
    public void stockExternalModesDoNotStartTheBundledAgent() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "remote-mac", RAM_12GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "tunnel-to-mobile", RAM_12GB));
    }

    @Test
    public void stockLocalModeStartsTheBundledAgentWhenRamAllows() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local", RAM_12GB));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local ", RAM_12GB));
    }

    @Test
    public void stockLocalModeIsRefusedBelowTheRamFloor() {
        // A persisted "local" survives reinstalls via Capacitor Preferences, so
        // a low-RAM device can carry one it can no longer honor — refusing here
        // is what keeps a 6 GB phone from wedging boot for the 180 s budget even
        // though it clears the lower hybrid floor.
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local", RAM_6GB));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local ", RAM_6GB));
    }

    @Test
    public void onDeviceAgentRuntimeModePredicateCoversLocalAndCloudHybridOnly() {
        assertTrue(ElizaAgentService.isOnDeviceAgentRuntimeMode("local"));
        assertTrue(ElizaAgentService.isOnDeviceAgentRuntimeMode(" cloud-hybrid "));
        assertFalse(ElizaAgentService.isOnDeviceAgentRuntimeMode("cloud"));
        assertFalse(ElizaAgentService.isOnDeviceAgentRuntimeMode("remote-mac"));
        assertFalse(ElizaAgentService.isOnDeviceAgentRuntimeMode(null));
    }

    @Test
    public void explicitStartUsesTheModeSpecificRamFloor() {
        long marketedFourGb = (long) (3.6 * (1L << 30));
        long belowHybridFloor = (long) (2.8 * (1L << 30));

        assertTrue(ElizaAgentService.allowsAgentStartForRuntimeMode(
            "cloud-hybrid", marketedFourGb));
        assertFalse(ElizaAgentService.allowsAgentStartForRuntimeMode(
            "local", marketedFourGb));
        assertFalse(ElizaAgentService.allowsAgentStartForRuntimeMode(
            "cloud-hybrid", belowHybridFloor));
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

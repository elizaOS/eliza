/**
 * Host-side coverage for the Android service boot gate that decides whether a
 * stock phone should spawn the bundled local agent before the renderer starts.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM unit tests for the stock-Android local-agent autostart policy. The
 * service must stay out of the first-run cloud path on low-RAM phones unless a
 * device image or an explicit local runtime choice needs the bundled agent.
 */
public class ElizaAgentAutostartPolicyTest {

    @Test
    public void brandedDevicesAlwaysStartTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, null));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "cloud"));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(true, "remote-mac"));
    }

    @Test
    public void stockFreshInstallDoesNotStartTheBundledAgent() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, null));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, ""));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "   "));
    }

    @Test
    public void stockCloudModesStayCloudFirst() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud"));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "cloud-hybrid"));
    }

    @Test
    public void stockExternalModesDoNotStartTheBundledAgent() {
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "remote-mac"));
        assertFalse(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "tunnel-to-mobile"));
    }

    @Test
    public void stockLocalModeStartsTheBundledAgent() {
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, "local"));
        assertTrue(ElizaAgentService.shouldAutoStartForRuntimeMode(false, " local "));
    }
}

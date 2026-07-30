/**
 * Verifies that Android reserves native stream identities before returning
 * them to the WebView, closing the cancellation race before the worker starts.
 */

package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.UUID;
import org.junit.Test;

public final class LocalAgentStreamRegistryTest {
    @Test
    public void cancellationOwnsAStreamBeforeItsSocketExists() {
        String streamId = "registry-test-" + UUID.randomUUID();

        assertTrue(ElizaAgentService.registerLocalAgentStream(streamId));
        assertFalse(ElizaAgentService.registerLocalAgentStream(streamId));
        assertTrue(ElizaAgentService.cancelLocalAgentStream(streamId));
        assertFalse(ElizaAgentService.cancelLocalAgentStream(streamId));
    }
}

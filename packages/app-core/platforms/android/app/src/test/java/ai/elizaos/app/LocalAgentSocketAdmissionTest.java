/**
 * Verifies that Android IPC admission reports an unavailable local runtime
 * immediately and never hides lifecycle failure behind transport retries.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class LocalAgentSocketAdmissionTest {
    @Test
    public void connectionFailureIsAttemptedOnceAndPreservesCause() {
        AtomicInteger attempts = new AtomicInteger();
        IOException unavailable = new IOException("connection refused");

        IOException error = assertThrows(IOException.class, () ->
            ElizaAgentService.connectLocalAgentSocket(() -> {
                attempts.incrementAndGet();
                throw unavailable;
            }));

        assertEquals(1, attempts.get());
        assertEquals(
            "Local agent is not ready: request socket is not accepting connections",
            error.getMessage());
        assertSame(unavailable, error.getCause());
    }
}

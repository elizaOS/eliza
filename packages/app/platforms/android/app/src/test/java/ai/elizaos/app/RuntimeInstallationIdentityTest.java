/** Exercises durable identity reuse, concurrent launchers and invalid-state rejection against real files. */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.IOException;
import java.util.ArrayList;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.Test;

public class RuntimeInstallationIdentityTest {
    @Test public void concurrentLaunchersAndRestartKeepOneIdentity() throws Exception {
        Path directory = Files.createTempDirectory("eliza-identity-");
        var executor = Executors.newFixedThreadPool(8);
        try {
            var calls = new ArrayList<Callable<String>>();
            for (int index = 0; index < 16; index++) calls.add(() -> RuntimeInstallationIdentity.ensure(directory));
            var results = executor.invokeAll(calls);
            String first = results.get(0).get();
            for (var result : results) assertEquals(first, result.get());
            assertEquals(first, RuntimeInstallationIdentity.ensure(directory));
            assertEquals(first, new String(Files.readAllBytes(directory.resolve("runtime-installation-id")), StandardCharsets.UTF_8).trim());
        } finally {
            executor.shutdownNow();
            remove(directory);
        }
    }

    @Test public void malformedIdentityIsNeverReplaced() throws Exception {
        Path directory = Files.createTempDirectory("eliza-identity-invalid-");
        try {
            Path target = directory.resolve("runtime-installation-id");
            Files.write(target, "invalid".getBytes(StandardCharsets.UTF_8));
            assertThrows(IOException.class, () -> RuntimeInstallationIdentity.ensure(directory));
            assertEquals("invalid", new String(Files.readAllBytes(target), StandardCharsets.UTF_8));
        } finally { remove(directory); }
    }

    @Test public void linkedIdentityIsRejectedWithoutChangingItsTarget() throws Exception {
        Path directory = Files.createTempDirectory("eliza-identity-link-");
        try {
            Path external = directory.resolve("external");
            Files.write(external, "00000000-0000-4000-8000-000000000000".getBytes(StandardCharsets.UTF_8));
            Files.createSymbolicLink(directory.resolve("runtime-installation-id"), external);
            assertThrows(IOException.class, () -> RuntimeInstallationIdentity.ensure(directory));
            assertEquals("00000000-0000-4000-8000-000000000000", new String(Files.readAllBytes(external), StandardCharsets.UTF_8));
        } finally { remove(directory); }
    }

    private static void remove(Path directory) throws IOException {
        try (var paths = Files.list(directory)) {
            for (Path child : paths.toList()) Files.delete(child);
        }
        Files.delete(directory);
    }
}

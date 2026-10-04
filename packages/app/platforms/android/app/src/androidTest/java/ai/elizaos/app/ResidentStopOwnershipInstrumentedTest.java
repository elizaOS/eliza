package ai.elizaos.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Assume;
import org.junit.Test;

/** Exercises the real service stop path, with an absent deployment that cannot signal any PID. */
public final class ResidentStopOwnershipInstrumentedTest {
    private static Field field(String name) throws Exception {
        Field field = ElizaAgentService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static final class IsolatedService extends ElizaAgentService {
        private final File files;
        private final ApplicationInfo applicationInfo;

        IsolatedService(Context context, File files) {
            attachBaseContext(context);
            this.files = files;
            applicationInfo = new ApplicationInfo(context.getApplicationInfo());
            applicationInfo.nativeLibraryDir = new File(files, "absent-native-libraries").getPath();
        }

        @Override public File getFilesDir() { return files; }
        @Override public ApplicationInfo getApplicationInfo() { return applicationInfo; }
    }

    @Test public void refusedStopPreservesOwnershipCredentialsAndRetry() throws Exception {
        Assume.assumeTrue("Explicit isolated lifecycle fixture required", "1".equals(
            InstrumentationRegistry.getArguments().getString("residentStopFixture")));
        assertTrue(BuildConfig.DEBUG);
        assertNull("Do not alter a running service's static credentials", field("activeInstance").get(null));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = Files.createTempDirectory(context.getCacheDir().toPath(), "resident-stop-").toFile();
        File auth = new File(root, "auth");
        assertTrue(auth.mkdir());
        File tokenFile = new File(auth, "local-agent-token");
        byte[] tokenBytes = "synthetic-stop-fixture".getBytes(StandardCharsets.UTF_8);
        Files.write(tokenFile.toPath(), tokenBytes);
        IsolatedService service = new IsolatedService(context, root);
        Field localToken = field("currentLocalAgentToken");
        Field terminalToken = field("currentTerminalRunToken");
        Object priorLocal = localToken.get(null);
        Object priorTerminal = terminalToken.get(null);
        Thread out = new Thread();
        Thread err = new Thread();
        try {
            field("detachedAgentMode").setBoolean(service, true);
            field("detachedLaunchStartedAtMs").setLong(service, 123456L);
            field("stdoutPump").set(service, out);
            field("stderrPump").set(service, err);
            localToken.set(null, "synthetic-local-token");
            terminalToken.set(null, "synthetic-terminal-token");
            Method stop = ElizaAgentService.class.getDeclaredMethod("stopAgentProcess", boolean.class);
            stop.setAccessible(true);
            // Both initial refusal and retry traverse the actual detached stop path.
            // Missing loader resolution fails before /proc enumeration or Os.kill.
            for (int attempt = 0; attempt < 2; attempt++) {
                InvocationTargetException failure = assertThrows(
                    InvocationTargetException.class, () -> stop.invoke(service, false));
                assertTrue(failure.getCause() instanceof IllegalStateException);
                assertEquals("Resident stop identity unproven", failure.getCause().getMessage());
                assertTrue(field("detachedAgentMode").getBoolean(service));
                assertEquals(123456L, field("detachedLaunchStartedAtMs").getLong(service));
                assertSame(out, field("stdoutPump").get(service));
                assertSame(err, field("stderrPump").get(service));
                assertEquals("synthetic-local-token", localToken.get(null));
                assertEquals("synthetic-terminal-token", terminalToken.get(null));
                assertArrayEquals(tokenBytes, Files.readAllBytes(tokenFile.toPath()));
                assertFalse(out.isInterrupted());
                assertFalse(err.isInterrupted());
            }
        } finally {
            localToken.set(null, priorLocal);
            terminalToken.set(null, priorTerminal);
            Files.deleteIfExists(tokenFile.toPath());
            Files.deleteIfExists(auth.toPath());
            Files.deleteIfExists(root.toPath());
        }
    }
}

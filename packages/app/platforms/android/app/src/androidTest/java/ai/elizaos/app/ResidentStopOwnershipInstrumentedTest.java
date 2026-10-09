package ai.elizaos.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicReference;
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

    private static void assumeFixture() {
        Assume.assumeTrue("Explicit isolated lifecycle fixture required", "1".equals(
            InstrumentationRegistry.getArguments().getString("residentStopFixture")));
        assertTrue(BuildConfig.DEBUG);
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    /** Runs {@code body} with a refusable detached runtime owned by an isolated service. */
    private interface OwnedRuntime { void run(IsolatedService service, File root) throws Exception; }

    private static void withOwnedRuntime(OwnedRuntime body) throws Exception {
        assertNull("Do not alter a running service's static credentials", field("activeInstance").get(null));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = Files.createTempDirectory(context.getCacheDir().toPath(), "resident-stop-").toFile();
        IsolatedService service = new IsolatedService(context, root);
        Field localToken = field("currentLocalAgentToken");
        Field terminalToken = field("currentTerminalRunToken");
        Object priorLocal = localToken.get(null);
        Object priorTerminal = terminalToken.get(null);
        try {
            field("detachedAgentMode").setBoolean(service, true);
            localToken.set(null, "synthetic-local-token");
            terminalToken.set(null, "synthetic-terminal-token");
            body.run(service, root);
        } finally {
            localToken.set(null, priorLocal);
            terminalToken.set(null, priorTerminal);
            deleteTree(root);
        }
    }

    @Test public void refusedStopDuringExplicitDestroyDoesNotEscape() throws Exception {
        assumeFixture();
        withOwnedRuntime((service, root) -> {
            field("shuttingDown").setBoolean(service, true);
            field("foregroundStartDenied").setBoolean(service, false);
            // Android rethrows an onDestroy exception as "Unable to stop service" and kills the app.
            service.onDestroy();
            assertTrue(field("detachedAgentMode").getBoolean(service));
            assertEquals("synthetic-local-token", field("currentLocalAgentToken").get(null));
            assertEquals("synthetic-terminal-token", field("currentTerminalRunToken").get(null));
        });
    }

    @Test public void refusedStopBeforeRestartDoesNotEscapeOrStartASecondRuntime() throws Exception {
        assumeFixture();
        Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
        AtomicReference<Throwable> escaped = new AtomicReference<>();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            if ("ElizaAgent-start".equals(thread.getName())) escaped.set(error);
            else if (prior != null) prior.uncaughtException(thread, error);
        });
        try {
            withOwnedRuntime((service, root) -> {
                Method request = ElizaAgentService.class.getDeclaredMethod("requestAgentStart", boolean.class);
                request.setAccessible(true);
                request.invoke(service, true);
                long deadline = SystemClock.elapsedRealtime() + 10_000;
                while (field("startWorker").get(service) != null && SystemClock.elapsedRealtime() < deadline)
                    SystemClock.sleep(20);
                assertNull("restart worker must finish", field("startWorker").get(service));
                assertNull("a refused stop must not escape the restart worker", escaped.get());
                assertEquals("stop-failed", field("currentStatus").get(service));
                assertTrue(field("detachedAgentMode").getBoolean(service));
                assertEquals("synthetic-local-token", field("currentLocalAgentToken").get(null));
            });
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(prior);
        }
    }

    @Test public void absentResidentUnderAliasedAppStorageReleasesOwnership() throws Exception {
        assumeFixture();
        withOwnedRuntime((service, root) -> {
            // App storage is normally reached through /data/user/0, an alias of /data/data.
            Assume.assumeFalse("App storage path is already canonical",
                root.getPath().equals(root.getCanonicalPath()));
            Method abi = ElizaAgentService.class.getDeclaredMethod("resolveRuntimeAbi");
            abi.setAccessible(true);
            File abiDir = new File(new File(root, "agent"), (String) abi.invoke(service));
            assertTrue(abiDir.mkdirs());
            // A complete deployment whose resident is not running: no process can
            // match this argv, so the stop enumerates /proc and signals nothing.
            Files.write(new File(abiDir, "ld-musl-fixture.so.1").toPath(), new byte[] {1});
            Files.write(new File(abiDir, "bun").toPath(), new byte[] {2});
            Method stop = ElizaAgentService.class.getDeclaredMethod("stopAgentProcess", boolean.class);
            stop.setAccessible(true);
            stop.invoke(service, false);
            assertFalse(field("detachedAgentMode").getBoolean(service));
            assertNull(field("currentLocalAgentToken").get(null));
            assertNull(field("currentTerminalRunToken").get(null));
        });
    }
}

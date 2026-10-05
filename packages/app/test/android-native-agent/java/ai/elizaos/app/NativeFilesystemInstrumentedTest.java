package ai.elizaos.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Bundle;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Executes the production filesystem service as children of the real Android app UID. */
@RunWith(AndroidJUnit4.class)
public class NativeFilesystemInstrumentedTest {
    private void export(String name, byte[] bytes) {
        Bundle status = new Bundle();
        status.putString("nativeArtifactName", name);
        status.putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
    }

    private void remove(File file) throws Exception {
        if (Files.isDirectory(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            File[] children = file.listFiles();
            assertNotNull(children);
            for (File child : children) remove(child);
        }
        Files.delete(file.toPath());
    }

    @Test
    public void productionServicePersistsAcrossAppSandboxProcesses() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = new File(context.getFilesDir(), "filesystem-e2e-" + UUID.randomUUID());
        assertTrue(root.mkdir());
        File nativeDir = new File(context.getApplicationInfo().nativeLibraryDir);
        File loader = new File(nativeDir, "libeliza_ld_musl_x86_64.so");
        File bun = new File(nativeDir, "libeliza_bun.so");
        assertTrue("Packaged Bun executable missing", bun.isFile());
        assertTrue("Packaged seccomp wrapper missing", loader.isFile());
        try {
            File contract = new File(root, "contract.js");
            try (InputStream input = context.getAssets().open("filesystem-contract.js")) {
                Files.copy(input, contract.toPath());
            }
            Files.createSymbolicLink(new File(root, "libstdc++.so.6").toPath(), new File(nativeDir, "libeliza_stdcpp.so").toPath());
            Files.createSymbolicLink(new File(root, "libgcc_s.so.1").toPath(), new File(nativeDir, "libeliza_gcc_s.so").toPath());
            for (String phase : new String[]{"write", "reopen"}) {
                File log = new File(root, phase + ".log");
                ProcessBuilder builder = new ProcessBuilder(loader.getAbsolutePath(), bun.getAbsolutePath(), contract.getAbsolutePath(), phase);
                builder.directory(root);
                builder.redirectErrorStream(true);
                builder.redirectOutput(log);
                builder.environment().put("ELIZA_STATE_DIR", new File(root, "state").getAbsolutePath());
                builder.environment().put("LD_LIBRARY_PATH", root.getAbsolutePath() + ":" + nativeDir.getAbsolutePath());
                Process process = builder.start();
                try {
                    assertTrue("Filesystem process timed out", process.waitFor(60, TimeUnit.SECONDS));
                    assertEquals("Filesystem process failed: " + new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8), 0, process.exitValue());
                } finally {
                    if (process.isAlive()) {
                        process.destroyForcibly();
                        assertTrue("Filesystem child did not terminate", process.waitFor(10, TimeUnit.SECONDS));
                    }
                    export("filesystem-" + phase + ".txt", Files.readAllBytes(log.toPath()));
                }
                File proof = new File(root, "state/" + phase + ".json");
                JSONObject evidence = new JSONObject(new String(Files.readAllBytes(proof.toPath()), StandardCharsets.UTF_8));
                assertTrue(evidence.getBoolean("pass"));
                assertEquals(phase, evidence.getString("phase"));
                assertEquals("Child must use the installed app UID", android.os.Process.myUid(), evidence.getInt("uid"));
                String domain = evidence.getString("selinuxContext");
                assertTrue("Child must be in the application SELinux domain: " + domain, domain.contains(":untrusted_app"));
                evidence.put("appPackage", context.getPackageName());
                export("filesystem-" + phase + ".json", evidence.toString().getBytes(StandardCharsets.UTF_8));
            }
        } finally {
            remove(root);
            assertFalse("Filesystem fixture leaked", root.exists());
        }
    }
}

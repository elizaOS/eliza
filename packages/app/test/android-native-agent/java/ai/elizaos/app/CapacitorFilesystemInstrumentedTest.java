package ai.elizaos.app;

import static org.junit.Assert.*;
import android.os.Bundle;
import android.util.Base64;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Calls the production service and actual Capacitor Filesystem across recreated WebViews. */
@RunWith(AndroidJUnit4.class)
public class CapacitorFilesystemInstrumentedTest {
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result); latch.countDown();
        }));
        assertTrue("WebView evaluation timed out", latch.await(10, TimeUnit.SECONDS));
        return value.get();
    }
    private void remove(java.io.File file) throws Exception {
        if (!file.exists()) return;
        if (Files.isDirectory(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            java.io.File[] children = file.listFiles();
            assertNotNull(children);
            for (java.io.File child : children) remove(child);
        }
        Files.delete(file.toPath());
    }
    @Test public void productionServiceUsesNativeFilesAcrossWebViewRecreation() throws Exception {
        var app = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String root = "eliza-capacitor-e2e-" + UUID.randomUUID();
        String script;
        try (var input = app.getAssets().open("filesystem-browser-contract.js")) {
            script = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        java.io.File directory = new java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), root);
        try {
        for (String phase : new String[]{"write", "reopen"}) {
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                while (!"true".equals(evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise && window.Capacitor.isPluginAvailable('Filesystem'))"))) {
                    assertTrue("Native Filesystem bridge unavailable", System.nanoTime() < deadline);
                    Thread.sleep(50);
                }
                evaluate(scenario, "window.filesystemRoot=" + JSONObject.quote(root) + ";window.filesystemPhase=" + JSONObject.quote(phase) + ";try { (0,eval)(" + JSONObject.quote(script) + "); } catch(error) { window.filesystemProof={pass:false,error:String(error),stack:error.stack}; }");
                JSONObject result = null;
                deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                while (System.nanoTime() < deadline) {
                    String encoded = evaluate(scenario, "JSON.stringify(window.filesystemProof || null)");
                    String raw = new JSONArray("[" + encoded + "]").getString(0);
                    if (!"null".equals(raw)) { result = new JSONObject(raw); break; }
                    Thread.sleep(50);
                }
                assertNotNull("Filesystem bridge contract timed out", result);
                Bundle status = new Bundle();
                status.putString("nativeArtifactName", "capacitor-filesystem-" + phase + ".json");
                status.putString("nativeArtifactBase64", Base64.encodeToString(result.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
                assertTrue(result.toString(), result.getBoolean("pass"));
                assertEquals(phase, result.getString("phase"));
                assertTrue(result.getInt("assertions") >= 20);
                if (phase.equals("write")) {
                    assertEquals(result.getString("text"), new String(Files.readAllBytes(new java.io.File(directory, "nested/文字.txt").toPath()), StandardCharsets.UTF_8));
                    assertArrayEquals(Base64.decode(result.getString("binaryBase64"), Base64.DEFAULT), Files.readAllBytes(new java.io.File(directory, "nested/binary.bin").toPath()));
                } else assertFalse("Native Documents fixture should be removed", directory.exists());
            }
        }
        } finally { remove(directory); }
    }
}

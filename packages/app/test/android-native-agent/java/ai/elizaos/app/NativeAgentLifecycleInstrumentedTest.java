package ai.elizaos.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.SystemClock;
import android.os.Bundle;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.io.File;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs only in the isolated full-host lane with the actual staged Bun bundle. */
@RunWith(AndroidJUnit4.class)
public class NativeAgentLifecycleInstrumentedTest {
    private void export(String name, byte[] data) {
        Bundle status = new Bundle();
        status.putString("nativeArtifactName", name);
        status.putString("nativeArtifactBase64", Base64.encodeToString(data, Base64.NO_WRAP));
        InstrumentationRegistry.getInstrumentation().sendStatus(2, status);
    }

    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, value -> {
            result.set(value);
            done.countDown();
        }));
        assertTrue("WebView callback timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void productionBridgeStartsAuthenticatesAndStopsBundledAgent() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("Only the isolated agent host lane may run this test", "1",
            InstrumentationRegistry.getArguments().getString("isolatedAgentHost"));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                assertEquals(ai.eliza.plugins.agent.AgentPlugin.class,
                    activity.getBridge().getPlugin("Agent").getInstance().getClass());
            });
            long readyDeadline = SystemClock.elapsedRealtime() + 30000;
            while (!"true".equals(evaluate(scenario, "typeof window.runAgentLifecycle === 'function' && !!window.Capacitor?.nativePromise"))) {
                assertTrue("Test page/native bridge unavailable", SystemClock.elapsedRealtime() < readyDeadline);
                Thread.sleep(250);
            }
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit()
                .putString("eliza:mobile-runtime-mode", "cloud-hybrid").commit();
            evaluate(scenario, "window.runAgentLifecycle(); true");
            long deadline = SystemClock.elapsedRealtime() + 240000;
            String result = "null";
            while (SystemClock.elapsedRealtime() < deadline) {
                result = evaluate(scenario, "JSON.stringify(window.agentResult || null)");
                Object decoded = new JSONTokener(result).nextValue();
                if (decoded instanceof String && !"null".equals(decoded)) {
                    JSONObject report = new JSONObject((String) decoded);
                    export("agent-lifecycle.json", report.toString(2).getBytes(StandardCharsets.UTF_8));
                    assertTrue(report.toString(2), report.getBoolean("ok"));
                    return;
                }
                Thread.sleep(500);
            }
            fail("Native agent lifecycle did not finish: " + result);
        } finally {
            try {
                File log = new File(context.getFilesDir(), "agent/agent.log");
                if (log.isFile()) export("agent-runtime.txt", Files.readAllBytes(log.toPath()));
            } finally {
                ElizaAgentService.stop(context);
            }
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
        }
    }
}

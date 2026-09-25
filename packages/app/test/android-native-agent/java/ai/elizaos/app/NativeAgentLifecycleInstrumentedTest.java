package ai.elizaos.app;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.SystemClock;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.io.File;
import java.io.InputStream;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONArray;
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

    private String shell(String command) throws Exception {
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** Capture before stop() changes child liveness. Never export tokens, env, argv, or fatal messages. */
    private void exportStartupDiagnostics(Context context) {
        JSONObject evidence = new JSONObject();
        JSONArray errors = new JSONArray();
        Set<Integer> pids = new LinkedHashSet<>();
        pids.add(android.os.Process.myPid());
        try {
            evidence.put("capturedBeforeStop", true);
            File journal = new File(context.getFilesDir(), "agent/agent-restart-diagnostics.jsonl");
            evidence.put("journalPresent", journal.isFile());
            JSONArray records = new JSONArray();
            int malformed = 0;
            if (journal.isFile()) {
                for (String line : Files.readAllLines(journal.toPath(), StandardCharsets.UTF_8)) {
                    if (line.trim().isEmpty()) continue;
                    try {
                        JSONObject raw = new JSONObject(line);
                        JSONObject record = new JSONObject();
                        record.put("ts", raw.optLong("ts", 0));
                        // Event names are internal identifiers; free-form status/fatal text is excluded.
                        String event = raw.optString("event", "");
                        if (event.matches("[a-z0-9-]+")) record.put("event", event);
                        JSONObject details = raw.optJSONObject("details");
                        if (details != null) {
                            for (String key : new String[]{"childPid", "exitCode", "launchStartedAtMs", "startupHealthGraceMs"}) {
                                String value = details.optString(key, "");
                                if (value.matches("[0-9]+")) record.put(key, value);
                            }
                            String pid = details.optString("childPid", "");
                            if (pid.matches("[0-9]+")) {
                                int parsed = Integer.parseInt(pid);
                                if (parsed > 0) pids.add(parsed);
                            }
                        }
                        records.put(record);
                    } catch (Exception invalid) {
                        malformed++;
                    }
                }
            }
            evidence.put("journalRecords", records);
            evidence.put("malformedJournalLines", malformed);
        } catch (Exception error) {
            errors.put("journal: " + error.getClass().getSimpleName());
        }
        try {
            // Fixed columns omit command arguments (which could contain credentials).
            JSONArray processes = new JSONArray();
            for (String line : shell("ps -A -o PID,PPID,STAT,NAME").split("\\n")) {
                String[] columns = line.trim().split("\\s+");
                if (columns.length < 4 || !columns[0].matches("[0-9]+")) continue;
                int pid = Integer.parseInt(columns[0]);
                if (pids.contains(pid)) processes.put(line.trim());
            }
            evidence.put("observedProcesses", processes);
        } catch (Exception error) {
            errors.put("processes: " + error.getClass().getSimpleName());
        }
        try {
            JSONArray crashes = new JSONArray();
            boolean ownedCrash = false;
            for (String line : shell("logcat -b crash -d -t 500").split("\\n")) {
                if (line.contains("*** *** ***")) ownedCrash = false;
                Matcher owner = Pattern.compile("pid: *([0-9]+),").matcher(line);
                if (owner.find()) ownedCrash = pids.contains(Integer.parseInt(owner.group(1)));
                // Native crash frames are emitted by crash_dump, not by the crashing PID.
                // Keep only our crash block's signal/backtrace, never Abort message payloads.
                if (ownedCrash && line.matches(".*(?:signal [0-9]+ \\(.*|#[0-9]+ pc [0-9a-f]+ .*|backtrace:)"))
                    crashes.put(line);
            }
            evidence.put("nativeCrashFrames", crashes);
        } catch (Exception error) {
            errors.put("crashBuffer: " + error.getClass().getSimpleName());
        }
        try {
            evidence.put("errors", errors);
            export("agent-startup-diagnostics.json", evidence.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            // Diagnostics must not replace the original lifecycle assertion failure.
            android.util.Log.e("TestRunner", "Startup diagnostics export failed", error);
        }
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
            try {
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
                exportStartupDiagnostics(context);
            }
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

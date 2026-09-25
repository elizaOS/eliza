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
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
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
        exportRunningChildProbe(evidence, errors, pids);
        try {
            evidence.put("errors", errors);
            export("agent-startup-diagnostics.json", evidence.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            // Diagnostics must not replace the original lifecycle assertion failure.
            android.util.Log.e("TestRunner", "Startup diagnostics export failed", error);
        }
    }

    /** One deadline covers both thread samples and the native backtrace, including command startup. */
    private void exportRunningChildProbe(JSONObject evidence, JSONArray errors, Set<Integer> pids) {
        int childPid = -1;
        for (int pid : pids) if (pid != android.os.Process.myPid()) childPid = pid;
        if (childPid <= 0) return;
        final long deadline = SystemClock.elapsedRealtime() + 9000;
        ExecutorService worker = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "startup-native-diagnostics");
            thread.setDaemon(true);
            return thread;
        });
        try {
            evidence.put("probedChildPid", childPid);
            JSONArray samples = new JSONArray();
            evidence.put("threadSamples", samples);
            String sampleCommand = "timeout 2 sh -c 'n=0; for d in /proc/" + childPid
                + "/task/[0-9]*; do [ -d \"$d\" ] || continue; n=$((n+1)); [ $n -le 32 ] || break; "
                + "echo TID:${d##*/}; cat \"$d/stat\"; echo WCHAN; cat \"$d/wchan\"; echo; done'";
            for (int sample = 0; sample < 2; sample++) {
                if (sample > 0) Thread.sleep(200);
                String raw = boundedShell(worker, sampleCommand, deadline);
                JSONObject observation = new JSONObject();
                observation.put("elapsedRealtimeMs", SystemClock.elapsedRealtime());
                JSONArray threads = new JSONArray();
                JSONObject thread = null;
                boolean nextWchan = false;
                for (String line : raw.split("\\n")) {
                    if (line.matches("TID:[0-9]+")) {
                        thread = new JSONObject();
                        thread.put("tid", line.substring(4));
                        threads.put(thread);
                    } else if (thread != null && line.equals("WCHAN")) {
                        nextWchan = true;
                    } else if (thread != null && nextWchan) {
                        if (line.matches("[A-Za-z0-9_]+")) thread.put("wchan", line);
                        nextWchan = false;
                    } else if (thread != null && line.matches("[0-9]+ \\(.*")) {
                        // Discard comm and all address fields. stat fields 14/15 are CPU ticks.
                        int end = line.lastIndexOf(')');
                        String[] fields = line.substring(end + 2).split("\\s+");
                        if (fields.length > 12 && fields[0].matches("[A-Za-z]")
                                && fields[11].matches("[0-9]+") && fields[12].matches("[0-9]+")) {
                            thread.put("state", fields[0]);
                            thread.put("userTicks", fields[11]);
                            thread.put("systemTicks", fields[12]);
                        }
                    }
                }
                if (threads.length() == 0) errors.put("threadSample: unavailable or denied");
                observation.put("threads", threads);
                samples.put(observation);
            }
            String trace = boundedShell(worker, "timeout 3 debuggerd -b " + childPid + " 2>&1", deadline);
            JSONArray frames = new JSONArray();
            boolean owned = false;
            for (String line : trace.split("\\n")) {
                Matcher header = Pattern.compile(".*----- pid ([0-9]+) at .*").matcher(line);
                if (header.matches()) owned = Integer.parseInt(header.group(1)) == childPid;
                if (line.contains("----- end ")) owned = false;
                // debuggerd -b only; exclude registers, memory, abort text, argv and other processes.
                if (owned && line.trim().matches("#[0-9]+ pc [0-9a-f]+ .*")) frames.put(line.trim());
            }
            evidence.put("runningChildFrames", frames);
            if (frames.length() == 0) errors.put("nativeBacktrace: no owned frames (unavailable or denied)");
        } catch (Exception error) {
            errors.put("runningChildProbe: " + error.getClass().getSimpleName());
        } finally {
            worker.shutdownNow();
        }
    }

    private String boundedShell(ExecutorService worker, String command, long deadline) throws Exception {
        long remaining = deadline - SystemClock.elapsedRealtime();
        if (remaining <= 0) throw new java.util.concurrent.TimeoutException("startup probe deadline");
        Future<String> pending = worker.submit(() -> {
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(
                    InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
                return new String(input.readNBytes(65536), StandardCharsets.UTF_8);
            }
        });
        try {
            return pending.get(remaining, TimeUnit.MILLISECONDS);
        } finally {
            pending.cancel(true);
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

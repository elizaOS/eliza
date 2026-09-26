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
        ExecutorService worker = Executors.newFixedThreadPool(3, task -> {
            Thread thread = new Thread(task, "startup-native-diagnostics");
            thread.setDaemon(true);
            return thread;
        });
        try {
            evidence.put("probedChildPid", childPid);
            JSONArray samples = new JSONArray();
            evidence.put("threadSamples", samples);
            for (int sample = 0; sample < 2; sample++) {
                if (sample > 0) Thread.sleep(200);
                final int targetPid = childPid;
                Future<String> pendingSample = worker.submit(() -> readOwnedThreads(targetPid));
                String raw;
                try {
                    raw = pendingSample.get(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS);
                } finally {
                    pendingSample.cancel(true);
                }
                JSONObject observation = new JSONObject();
                observation.put("elapsedRealtimeMs", SystemClock.elapsedRealtime());
                JSONArray threads = new JSONArray();
                JSONObject thread = null;
                boolean nextWchan = false;
                for (String line : raw.split("\\n")) {
                    if (line.equals("UNAVAILABLE")) errors.put("threadFile: unavailable or denied");
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
            String sampler = InstrumentationRegistry.getArguments().getString("startupPcSampler", "");
            if (!sampler.matches("/data/local/tmp/eliza-startup-pc-[0-9]+")) {
                errors.put("pcSampler: verified root helper unavailable");
                return;
            }
            String[] result = boundedNativeProbe(worker, sampler, childPid, deadline);
            JSONArray frames = new JSONArray();
            for (String line : result[0].split("\\n")) {
                if (line.matches("sample:[01] module:[A-Za-z0-9._\\[\\]-]+ pc_offset:[0-9a-f]+")
                        || line.equals("detached") || line.matches("error:[a-z0-9_]+")) frames.put(line);
            }
            evidence.put("runningChildPcSamples", frames);
            if (frames.length() == 0) errors.put("pcSampler: no records");
            if (!result[1].isBlank()) errors.put("pcSampler: diagnostic stderr present");
        } catch (Exception error) {
            errors.put("runningChildProbe: " + error.getClass().getSimpleName());
        } finally {
            worker.shutdownNow();
        }
    }

    /** Read as the instrumentation/target app UID, not UiAutomation's shell UID. */
    private String readOwnedThreads(int pid) throws Exception {
        File[] tasks = new File("/proc/" + pid + "/task").listFiles();
        if (tasks == null) throw new java.io.IOException("task directory unavailable");
        StringBuilder result = new StringBuilder();
        int remainingBytes = 65536;
        int count = 0;
        for (File task : tasks) {
            if (!task.getName().matches("[0-9]+")) continue;
            if (++count > 32 || remainingBytes <= 0 || Thread.currentThread().isInterrupted()) break;
            result.append("TID:").append(task.getName()).append('\n');
            for (String leaf : new String[]{"stat", "wchan"}) {
                if (leaf.equals("wchan")) result.append("WCHAN\n");
                try (InputStream input = Files.newInputStream(new File(task, leaf).toPath())) {
                    byte[] bytes = input.readNBytes(Math.min(remainingBytes, 2048));
                    remainingBytes -= bytes.length;
                    result.append(new String(bytes, StandardCharsets.UTF_8).trim()).append('\n');
                } catch (java.io.IOException unavailable) {
                    result.append("UNAVAILABLE\n");
                }
            }
        }
        return result.toString();
    }

    private String[] boundedNativeProbe(ExecutorService worker, String sampler, int pid, long deadline) throws Exception {
        // UiAutomation uses Runtime.exec(String): it does not parse shell quoting or redirections.
        Future<ParcelFileDescriptor[]> launch = worker.submit(() -> InstrumentationRegistry.getInstrumentation()
            .getUiAutomation().executeShellCommandRwe("su 0 timeout 3 " + sampler + " " + pid + " " + android.os.Process.myUid()));
        ParcelFileDescriptor[] streams;
        try {
            streams = launch.get(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS);
        } finally {
            launch.cancel(true);
        }
        // Rwe order is stdout, stdin, stderr. Close stdin; drain both outputs concurrently.
        streams[1].close();
        try (InputStream stdout = new ParcelFileDescriptor.AutoCloseInputStream(streams[0]);
             InputStream stderr = new ParcelFileDescriptor.AutoCloseInputStream(streams[2])) {
            Future<String> out = worker.submit(() -> new String(stdout.readNBytes(32768), StandardCharsets.UTF_8));
            Future<String> err = worker.submit(() -> new String(stderr.readNBytes(32768), StandardCharsets.UTF_8));
            try {
                return new String[]{
                    out.get(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS),
                    err.get(Math.max(1, deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS)
                };
            } finally {
                out.cancel(true);
                err.cancel(true);
            }
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
        boolean lifecyclePassed = false;
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
                        lifecyclePassed = true;
                        return;
                    }
                    Thread.sleep(500);
                }
                fail("Native agent lifecycle did not finish: " + result);
            } finally {
                if (!lifecyclePassed) exportStartupDiagnostics(context);
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

package ai.eliza.plugins.system.crash;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import android.os.Looper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Host JVM checks of the shared privacy-bounded problem log with Android stand-ins. */
public final class CrashLogTest {
    private static int checks;
    private static final String SECRET = "note: 221B Baker Street, account owner@example.com";

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }

    static JSONObject last(JSONArray entries, String source) throws Exception {
        for (int i = entries.length() - 1; i >= 0; i--) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && source.equals(entry.optString("source", ""))) return entry;
        }
        return null;
    }

    static final class Leaky extends RuntimeException {
        Leaky(String message, Throwable cause) { super(message, cause); }
    }

    public static void main(String[] args) throws Exception {
        Context context = new Context();
        CrashLog.clear(context);

        // Uncaught: class names only; the previous handler still runs.
        AtomicReference<Throwable> delegated = new AtomicReference<>();
        Thread.UncaughtExceptionHandler handler = CrashLog.handler(context, (thread, error) -> delegated.set(error));
        Leaky crash = new Leaky(SECRET, new IllegalStateException(SECRET));
        handler.uncaughtException(Looper.getMainLooper().getThread(), crash);
        check(delegated.get() == crash, "previous handler receives the original crash");
        String bytes = new String(Files.readAllBytes(CrashLog.file(context).toPath()), StandardCharsets.UTF_8);
        check(!bytes.contains("Baker") && !bytes.contains("example.com"), "no message reaches storage");
        JSONObject entry = last(CrashLog.read(context).getJSONArray("entries"), "uncaught");
        check(entry != null && entry.getString("errorClass").equals("ai.eliza.plugins.system.crash.CrashLogTest$Leaky"), "error class");
        check(entry.getString("rootClass").equals("java.lang.IllegalStateException") && entry.getString("thread").equals("main"), "root class and thread");
        handler.uncaughtException(new Thread(), new RuntimeException(SECRET));
        check(last(CrashLog.read(context).getJSONArray("entries"), "uncaught").getString("thread").equals("background"), "background thread");

        // A failing log never masks the crash.
        Context broken = new Context();
        broken.noBackupBroken = true;
        delegated.set(null);
        CrashLog.handler(broken, (thread, error) -> delegated.set(error)).uncaughtException(new Thread(), crash);
        check(delegated.get() == crash, "an unwritable log still delegates");

        // Renderer: known kinds only, identifier classes only.
        CrashLog.recordRenderer(context, "render", "TypeError");
        try { CrashLog.recordRenderer(context, "made-up", "TypeError"); check(false, "unknown kinds are refused"); }
        catch (IllegalArgumentException expected) { checks++; }
        CrashLog.recordRenderer(context, "startup", SECRET);
        check(last(CrashLog.read(context).getJSONArray("entries"), "renderer").getString("errorClass").equals("Error"), "non-identifier class becomes Error");

        // Bounded entries.
        for (int i = 0; i < CrashLog.MAX_ENTRIES + 5; i++) CrashLog.recordRenderer(context, "uncaught", "RangeError");
        check(CrashLog.read(context).getJSONArray("entries").length() == CrashLog.MAX_ENTRIES, "bounded to MAX_ENTRIES");

        // Retention: an entry older than RETENTION_MS is dropped on read.
        CrashLog.clear(context);
        JSONObject old = new JSONObject();
        old.put("source", "renderer"); old.put("kind", "render"); old.put("errorClass", "Error");
        old.put("at", System.currentTimeMillis() - CrashLog.RETENTION_MS - 1000);
        CrashLog.record(context, old, System.currentTimeMillis() - CrashLog.RETENTION_MS - 1000);
        check(CrashLog.read(context).getJSONArray("entries").length() == 0, "expired entries dropped");

        // Damaged and oversized files start again.
        Files.write(CrashLog.file(context).toPath(), "{not json".getBytes(StandardCharsets.UTF_8));
        check(CrashLog.read(context).getJSONArray("entries").length() == 0, "damaged file starts again");
        Files.write(CrashLog.file(context).toPath(), new byte[CrashLog.MAX_FILE_BYTES + 10]);
        check(CrashLog.read(context).getJSONArray("entries").length() == 0, "oversized file starts again");

        // Exit reasons: problem exits once each, ordinary exits skipped, process labels redacted.
        long now = System.currentTimeMillis();
        ActivityManager.exits.add(new ApplicationExitInfo(now - 3000, ApplicationExitInfo.REASON_CRASH, 0, "fixture.example"));
        ActivityManager.exits.add(new ApplicationExitInfo(now - 2000, ApplicationExitInfo.REASON_USER_REQUESTED, 0, "fixture.example"));
        ActivityManager.exits.add(new ApplicationExitInfo(now - 1500, ApplicationExitInfo.REASON_EXIT_SELF, 0, "fixture.example"));
        ActivityManager.exits.add(new ApplicationExitInfo(now - 1000, ApplicationExitInfo.REASON_ANR, 0, "fixture.example:isolated_pdf"));
        ActivityManager.exits.add(new ApplicationExitInfo(now - 500, ApplicationExitInfo.REASON_EXIT_SELF, 1, "com.other:" + SECRET));
        CrashLog.collectExitReasons(context);
        CrashLog.collectExitReasons(context);
        JSONArray entries = CrashLog.read(context).getJSONArray("entries");
        int exits = 0;
        for (int i = 0; i < entries.length(); i++) if ("exit".equals(entries.getJSONObjectAt(i).optString("source", ""))) exits++;
        check(exits == 3, "three problem exits recorded once, got " + exits);
        check(CrashLog.read(context).optLong("lastExitAt", 0) == now - 500, "newest exit remembered");
        check(!CrashLog.read(context).toString().contains("Baker"), "exit process names never stored");
        check(CrashLog.processLabel("fixture.example", "fixture.example:isolated_pdf").equals(":isolated_pdf"), "named process");
        check(CrashLog.processLabel("fixture.example", "fixture.example:bad name!").equals("other"), "odd suffix");
        check(CrashLog.processLabel("fixture.example", null).equals("main"), "main");
        Build.VERSION.SDK_INT = 29;
        ActivityManager.exits.add(new ApplicationExitInfo(now, ApplicationExitInfo.REASON_CRASH, 0, "fixture.example"));
        CrashLog.collectExitReasons(context);
        check(CrashLog.read(context).optLong("lastExitAt", 0) == now - 500, "Android 10 has no exit history");
        Build.VERSION.SDK_INT = 36;

        // Clear keeps the exit watermark so old exits are not recorded again.
        CrashLog.clear(context);
        CrashLog.collectExitReasons(context);
        check(CrashLog.read(context).getJSONArray("entries").length() == 1, "only the new exit after clear");

        // Export re-applies the allowlist to anything an older build wrote.
        JSONObject injected = new JSONObject();
        injected.put("source", "uncaught"); injected.put("errorClass", "java.lang.Error"); injected.put("message", SECRET);
        injected.put("thread", SECRET); injected.put("process", SECRET);
        CrashLog.record(context, injected, System.currentTimeMillis());
        JSONObject unknown = new JSONObject();
        unknown.put("source", "trace"); unknown.put("text", SECRET);
        CrashLog.record(context, unknown, System.currentTimeMillis());
        String exported = CrashLog.export(context).toString();
        check(!exported.contains("Baker") && !exported.contains("\"message\"") && !exported.contains("trace"), "export is redacted: " + exported);
        check(exported.contains("java.lang.Error") && exported.contains("\"version\":1"), "export keeps classes");

        System.out.println("PASS crash log (" + checks + " checks)");
    }
}

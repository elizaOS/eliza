package ai.eliza.plugins.system.crash;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import android.os.Looper;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Privacy-bounded local problem log shared by elizaOS Android hosts. It keeps only failure classes:
 * an uncaught exception's class names, Android's recorded process exit reason, and renderer
 * failure kinds. It never keeps messages, stack traces, exit descriptions, trace files, URLs or
 * user content, because any of them can carry note text, addresses or account data.
 *
 * <p>Stored as one {@link AtomicFile} ({@code no_backup/crash-log/v1.json}, a stable installed
 * path), bounded to {@link #MAX_ENTRIES} entries, {@link #RETENTION_MS} and {@link #MAX_FILE_BYTES};
 * a missing or damaged file starts again. {@link #export} re-applies the field allowlist, so a
 * value written by an older build is never exported verbatim.
 *
 * <p>Hosts call {@link #install} from {@code Application.onCreate} in the main process, expose
 * {@link #read}/{@link #recordRenderer}/{@link #clear} through their bridge, and call
 * {@link #collectExitReasons} when the log is read or a service restarts.
 */
public final class CrashLog {
    public static final int MAX_ENTRIES = 50;
    public static final long RETENTION_MS = 30L * 24 * 60 * 60 * 1000;
    public static final int MAX_FILE_BYTES = 256 * 1024;
    private static final Object LOCK = new Object();
    private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$.]{0,159}");
    private static final Pattern RENDERER_KIND = Pattern.compile("render|startup|uncaught");
    private static final Pattern RENDERER_CLASS = Pattern.compile("[A-Za-z][A-Za-z0-9]{0,63}");
    private static final Pattern PROCESS_LABEL = Pattern.compile("main|other|:[A-Za-z0-9_]{1,40}");
    private static final Pattern EXIT_REASON = Pattern.compile(
            "crash|native-crash|anr|low-memory|signaled|initialization-failure|excessive-resource-usage|dependency-died|freezer|other|unknown|exit-self");

    private CrashLog() {}

    public static File file(Context context) {
        return new File(new File(context.getApplicationContext().getNoBackupFilesDir(), "crash-log"), "v1.json");
    }

    /** Main process only: records the failure class first, then lets the previous handler crash the app as usual. */
    public static void install(Context context) {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(handler(context.getApplicationContext(), previous));
    }

    public static Thread.UncaughtExceptionHandler handler(Context context, Thread.UncaughtExceptionHandler next) {
        return (thread, error) -> {
            try {
                JSONObject entry = new JSONObject();
                entry.put("source", "uncaught");
                entry.put("errorClass", errorClass(error));
                Throwable root = error;
                for (int depth = 0; root != null && root.getCause() != null && root.getCause() != root && depth < 16; depth++)
                    root = root.getCause();
                if (root != null && root != error) entry.put("rootClass", errorClass(root));
                Looper main = Looper.getMainLooper();
                entry.put("thread", main != null && thread == main.getThread() ? "main" : "background");
                entry.put("process", "main");
                record(context, entry, System.currentTimeMillis());
            } catch (Throwable ignored) {
                // Never mask the original crash.
            }
            if (next != null) next.uncaughtException(thread, error);
        };
    }

    /** The throwable's class name when it is a plain Java identifier path, otherwise "Throwable". */
    public static String errorClass(Throwable error) {
        String name = error == null ? "" : error.getClass().getName();
        return CLASS_NAME.matcher(name).matches() ? name : "Throwable";
    }

    /** Renderer failure classes reported by an error boundary. Unknown kinds are refused. */
    public static void recordRenderer(Context context, String kind, String errorClass) throws Exception {
        if (kind == null || !RENDERER_KIND.matcher(kind).matches()) throw new IllegalArgumentException("kind");
        String cls = errorClass != null && RENDERER_CLASS.matcher(errorClass).matches() ? errorClass : "Error";
        JSONObject entry = new JSONObject();
        entry.put("source", "renderer");
        entry.put("kind", kind);
        entry.put("errorClass", cls);
        entry.put("process", "main");
        record(context, entry, System.currentTimeMillis());
    }

    /** Android 11+: records the system's recorded problem exits of this package's processes, once each. */
    public static void collectExitReasons(Context context) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return;
        List<ApplicationExitInfo> exits = manager.getHistoricalProcessExitReasons(null, 0, 16);
        synchronized (LOCK) {
            JSONObject doc = readLocked(context);
            long last = doc.optLong("lastExitAt", 0), newest = last;
            boolean changed = false;
            for (ApplicationExitInfo exit : exits) {
                long at = exit.getTimestamp();
                if (at <= last) continue;
                newest = Math.max(newest, at);
                String reason = exitReason(exit.getReason(), exit.getStatus());
                if (reason == null) continue;
                JSONObject entry = new JSONObject();
                entry.put("source", "exit");
                entry.put("reason", reason);
                entry.put("process", processLabel(context.getPackageName(), exit.getProcessName()));
                entry.put("at", at);
                append(doc, entry);
                changed = true;
            }
            if (newest != last) {
                doc.put("lastExitAt", newest);
                changed = true;
            }
            if (changed) writeLocked(context, doc, System.currentTimeMillis());
        }
    }

    /**
     * The problem class of an Android exit reason, or null for an ordinary exit (user, update,
     * permission change, clean self-exit). The constants are compile-time values, so the mapping
     * needs no API-level guard.
     */
    public static String exitReason(int reason, int status) {
        switch (reason) {
            case ApplicationExitInfo.REASON_CRASH: return "crash";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "native-crash";
            case ApplicationExitInfo.REASON_ANR: return "anr";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "low-memory";
            case ApplicationExitInfo.REASON_SIGNALED: return "signaled";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "initialization-failure";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "excessive-resource-usage";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "dependency-died";
            case ApplicationExitInfo.REASON_FREEZER: return "freezer";
            case ApplicationExitInfo.REASON_OTHER: return "other";
            case ApplicationExitInfo.REASON_UNKNOWN: return "unknown";
            case ApplicationExitInfo.REASON_EXIT_SELF: return status == 0 ? null : "exit-self";
            default: return null;
        }
    }

    /** Process identity without user data: "main", a named suffix such as ":isolated_pdf", or "other". */
    public static String processLabel(String packageName, String process) {
        if (process == null || process.equals(packageName)) return "main";
        if (packageName != null && process.startsWith(packageName + ":")) {
            String suffix = process.substring(packageName.length());
            if (suffix.matches(":[A-Za-z0-9_]{1,40}")) return suffix;
        }
        return "other";
    }

    public static JSONObject read(Context context) throws Exception {
        synchronized (LOCK) {
            JSONObject doc = readLocked(context);
            prune(doc, System.currentTimeMillis());
            return doc;
        }
    }

    /**
     * The redacted export: a fresh document holding only allowlisted fields of retained entries, so a
     * support bundle never carries anything the recorder would refuse to write today.
     */
    public static JSONObject export(Context context) throws Exception {
        JSONArray entries = read(context).getJSONArray("entries"), out = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject redacted = redact(entries.optJSONObject(i));
            if (redacted != null) out.put(redacted);
        }
        JSONObject doc = new JSONObject();
        doc.put("version", 1);
        doc.put("entries", out);
        return doc;
    }

    /** One entry with only allowlisted fields and shapes, or null when its source or reason is unknown. */
    public static JSONObject redact(JSONObject entry) throws Exception {
        if (entry == null) return null;
        long at = entry.optLong("at", 0);
        String source = entry.optString("source", "");
        if (at <= 0) return null;
        JSONObject out = new JSONObject();
        out.put("at", at);
        out.put("source", source);
        switch (source) {
            case "renderer": {
                String kind = entry.optString("kind", "");
                if (!RENDERER_KIND.matcher(kind).matches()) return null;
                out.put("kind", kind);
                String cls = entry.optString("errorClass", "");
                if (RENDERER_CLASS.matcher(cls).matches()) out.put("errorClass", cls);
                break;
            }
            case "exit": {
                String reason = entry.optString("reason", "");
                if (!EXIT_REASON.matcher(reason).matches()) return null;
                out.put("reason", reason);
                break;
            }
            case "uncaught": {
                String cls = entry.optString("errorClass", ""), root = entry.optString("rootClass", "");
                if (CLASS_NAME.matcher(cls).matches()) out.put("errorClass", cls);
                if (CLASS_NAME.matcher(root).matches()) out.put("rootClass", root);
                String thread = entry.optString("thread", "");
                if (thread.equals("main") || thread.equals("background")) out.put("thread", thread);
                break;
            }
            default:
                return null;
        }
        String process = entry.optString("process", "");
        if (PROCESS_LABEL.matcher(process).matches()) out.put("process", process);
        return out;
    }

    public static void clear(Context context) throws Exception {
        synchronized (LOCK) {
            JSONObject doc = readLocked(context);
            JSONObject next = new JSONObject();
            next.put("version", 1);
            next.put("lastExitAt", doc.optLong("lastExitAt", 0));
            next.put("entries", new JSONArray());
            writeLocked(context, next, System.currentTimeMillis());
        }
    }

    static void record(Context context, JSONObject entry, long now) throws Exception {
        synchronized (LOCK) {
            if (!entry.has("at")) entry.put("at", now);
            JSONObject doc = readLocked(context);
            append(doc, entry);
            writeLocked(context, doc, now);
        }
    }

    private static void append(JSONObject doc, JSONObject entry) throws Exception {
        doc.getJSONArray("entries").put(entry);
    }

    private static void prune(JSONObject doc, long now) throws Exception {
        JSONArray entries = doc.getJSONArray("entries"), kept = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject e = entries.optJSONObject(i);
            if (e != null && e.optLong("at", 0) > now - RETENTION_MS && e.optLong("at", 0) <= now + RETENTION_MS) kept.put(e);
        }
        JSONArray bounded = new JSONArray();
        for (int i = Math.max(0, kept.length() - MAX_ENTRIES); i < kept.length(); i++) bounded.put(kept.get(i));
        doc.put("entries", bounded);
    }

    private static JSONObject empty() {
        try {
            JSONObject doc = new JSONObject();
            doc.put("version", 1);
            doc.put("lastExitAt", 0);
            doc.put("entries", new JSONArray());
            return doc;
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static JSONObject readLocked(Context context) {
        AtomicFile file = new AtomicFile(file(context));
        try (InputStream in = file.openRead()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0, count;
            while ((count = in.read(buffer)) != -1) {
                total += count;
                if (total > MAX_FILE_BYTES) throw new IOException("Crash log too large");
                bytes.write(buffer, 0, count);
            }
            JSONObject doc = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (doc.optInt("version") != 1 || doc.optJSONArray("entries") == null) throw new IOException("Unrecognized crash log");
            return doc;
        } catch (Exception missingOrDamaged) {
            // A missing or damaged log starts again; it holds no user data worth recovering.
            return empty();
        }
    }

    private static void writeLocked(Context context, JSONObject doc, long now) throws Exception {
        prune(doc, now);
        File target = file(context);
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Crash log directory unavailable");
        AtomicFile file = new AtomicFile(target);
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(doc.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (Exception error) {
            if (out != null) file.failWrite(out);
            throw error;
        }
    }
}

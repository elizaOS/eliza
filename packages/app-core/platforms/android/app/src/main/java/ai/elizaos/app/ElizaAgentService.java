package ai.elizaos.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Foreground service that owns the local Eliza agent process on Android.
 *
 * On startup the service unpacks the bun runtime + musl loader + matching
 * shared libraries + agent bundle from the APK assets into the app's
 * writable data dir, marks them executable, and {@link Runtime#exec}'s
 * the agent. A foreground notification keeps the OS from killing the
 * hosting process; a watchdog thread polls process liveness and the
 * agent's HTTP health endpoint and restarts the process on crash with
 * exponential backoff.
 *
 * Mirrors {@link GatewayConnectionService}'s lifecycle and static API
 * shape — start/stop/restart helpers match what other call sites already
 * use.
 */
public class ElizaAgentService extends Service {

    private static final String TAG = "ElizaAgent";

    private static final String CHANNEL_ID = "eliza_agent";
    private static final int NOTIFICATION_ID = 2;

    // Intent actions
    public static final String ACTION_START = "ai.elizaos.app.action.START_AGENT";
    public static final String ACTION_STOP = "ai.elizaos.app.action.STOP_AGENT";
    public static final String ACTION_RESTART = "ai.elizaos.app.action.RESTART_AGENT";
    public static final String ACTION_UPDATE_STATUS = "ai.elizaos.app.action.UPDATE_AGENT_STATUS";

    // Extras
    private static final String EXTRA_STATUS = "status";

    // Agent layout under getFilesDir():
    //   agent/                     ← cwd, also holds agent-bundle.js + launch.sh
    //   agent/{abi}/bun
    //   agent/{abi}/ld-musl-*.so.1
    //   agent/{abi}/libstdc++.so.6
    //   agent/{abi}/libgcc_s.so.1
    //   .eliza/                   ← ELIZA_STATE_DIR (PGlite data, auth, prompts)
    //
    // The agent runs in the priv_app SELinux domain — Android.bp deliberately
    // omits the platform certificate so seapp_contexts puts the APK there
    // instead of platform_app. AOSP's stock policy includes
    // `allow priv_app privapp_data_file:file execute;` in
    // system/sepolicy/private/priv_app.te, which is what lets us execve
    // the bun binary out of /data/data/<pkg>/files/agent/. No jniLibs
    // trick, no custom domain, no symlinks: the binary just sits in the
    // app's writable data dir at canonical names.
    private static final String AGENT_DIR_NAME = "agent";
    private static final String AGENT_STATE_DIR_NAME = ".eliza";
    private static final String AGENT_BUNDLE_NAME = "agent-bundle.js";
    private static final String AGENT_LAUNCH_SCRIPT = "launch.sh";
    private static final String BUN_BINARY = "bun";
    private static final String AGENT_LOG_NAME = "agent.log";

    private static final int AGENT_PORT = 31337;
    private static final String HEALTH_URL = "http://127.0.0.1:" + AGENT_PORT + "/api/health";

    // The on-device boot path is heavy: PGlite extension extraction +
    // plugin resolution + libllama dlopen + first-time model load can
    // exceed 240 s on a cold cuttlefish x86_64 image. The chat path is
    // even heavier: a single planner-produced prompt at ~12k tokens,
    // chunked through llama_decode on emulated CPU, can run 15–30 min
    // wall-clock for a single chat turn (multiple model invocations:
    // planner, action evaluator, response generator).
    //
    // Strategy: combine a generous interval with a smart probe that
    // distinguishes "process dead" from "process alive but busy in a
    // native FFI call". When the HTTP probe times out but the process
    // is alive (i.e. bun is mid-llama_decode and hasn't returned to its
    // event loop yet), we DO NOT count a strike — the process is doing
    // exactly what it should be doing, just synchronously inside a
    // native call. We only count strikes when the process is actually
    // dead OR returns 5xx from /api/health (a real crash signal).
    // Strikes accumulate when the process is dead, which forces a
    // restart via the existing scheduleRestart() path.
    //
    // 600 s × 3 = 1800 s = 30 min worst-case grace window. Real phone
    // hardware (Tensor / Adreno) finishes a chat turn in seconds, so
    // this only matters for AOSP smoke runs on cvd. HEALTH_TIMEOUT_MS
    // = 30 s is a conservative bound on a single HTTP listener wakeup
    // — bun's setImmediate yield should hit within a few seconds even
    // mid-decode, and 30 s catches genuine TCP-level hangs without
    // racing against real long-running calls.
    private static final long WATCHDOG_INTERVAL_MS = 600_000L;
    private static final int HEALTH_FAIL_STRIKES = 3;
    private static final long HEALTH_TIMEOUT_MS = 30_000L;
    private static final int MAX_RESTART_ATTEMPTS = 5;
    private static final long PROCESS_TERMINATE_GRACE_MS = 5_000L;

    private final Object processLock = new Object();
    private Process agentProcess;
    private Thread stdoutPump;
    private Thread stderrPump;
    private WatchdogThread watchdog;
    private Thread startWorker;
    private volatile boolean shuttingDown;
    private int restartAttempts;
    private String currentStatus = "starting";

    // Per-boot bearer token for the WebView↔agent loopback. Generated when
    // the service first starts the agent process and cleared on stop.
    // The Capacitor agent plugin reads it from `localAgentToken()` to
    // hydrate `window.__ELIZA_API_TOKEN__` so the WebView's fetches
    // include `Authorization: Bearer <token>`. The agent enforces the
    // token via ELIZA_REQUIRE_LOCAL_AUTH=1.
    private static volatile String currentLocalAgentToken;

    /** Called by the Capacitor agent plugin Android binding. */
    public static String localAgentToken() {
        return currentLocalAgentToken;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();

        Notification notification = buildNotification("Eliza agent", "Starting…");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            shuttingDown = true;
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_RESTART.equals(action)) {
            Log.i(TAG, "Restart requested via intent.");
            restartAttempts = 0;
            requestAgentStart(true);
            return START_STICKY;
        }
        if (ACTION_UPDATE_STATUS.equals(action)) {
            String status = intent.getStringExtra(EXTRA_STATUS);
            if (status != null) {
                currentStatus = status;
                updateNotification();
            }
            return START_STICKY;
        }

        // ACTION_START or null (default) — boot the agent if it isn't already up.
        requestAgentStart(false);
        if (watchdog == null) {
            watchdog = new WatchdogThread();
            watchdog.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shuttingDown = true;
        if (watchdog != null) {
            watchdog.interrupt();
            watchdog = null;
        }
        stopAgentProcess();
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.cancel(NOTIFICATION_ID);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        // Not a bound service.
        return null;
    }

    // ── Asset extraction ─────────────────────────────────────────────────

    /**
     * Pick the runtime ABI directory we ship binaries for. Walks
     * Build.SUPPORTED_ABIS in device-priority order so x86_64 cuttlefish
     * (which lists ["x86_64","arm64-v8a"]) doesn't wrongly pick arm64.
     */
    private String resolveRuntimeAbi() {
        String[] supported = Build.SUPPORTED_ABIS;
        if (supported != null) {
            for (String abi : supported) {
                if ("arm64-v8a".equals(abi) || "x86_64".equals(abi)) return abi;
            }
            if (supported.length > 0) return supported[0];
        }
        return "arm64-v8a";
    }

    private File agentRoot() {
        return new File(getFilesDir(), AGENT_DIR_NAME);
    }

    private File agentAbiDir(String abi) {
        return new File(agentRoot(), abi);
    }

    private File agentStateDir() {
        return new File(getFilesDir(), AGENT_STATE_DIR_NAME);
    }

    /**
     * Copy assets/agent/** into the app's data dir on first launch.
     * Idempotent: skips files that already exist on disk and are
     * non-empty. Sets +x on bun, the musl loader, and launch.sh.
     */
    private void extractAssetsIfNeeded(String abi) throws IOException {
        File root = agentRoot();
        File abiDir = agentAbiDir(abi);
        File stateDir = agentStateDir();
        if (!root.exists() && !root.mkdirs()) {
            throw new IOException("Could not create " + root);
        }
        if (!abiDir.exists() && !abiDir.mkdirs()) {
            throw new IOException("Could not create " + abiDir);
        }
        if (!stateDir.exists() && !stateDir.mkdirs()) {
            throw new IOException("Could not create " + stateDir);
        }

        // Compare APK source-file mtime against a stamp file in the agent
        // root; when the APK was upgraded under us (adb push to
        // /system/priv-app + reboot, a Play update, or an OTA) wipe the
        // cached bundle + ABI binaries so the new asset payload gets
        // re-extracted. Without this, copyAssetIfMissing silently keeps
        // the previous extraction forever and shipping a fresh
        // agent-bundle.js does nothing.
        //
        // We use the APK file's mtime (sourceDir → File.lastModified)
        // rather than PackageInfo.lastUpdateTime because /system/priv-app
        // installs (the AOSP image embed path) DO NOT bump
        // lastUpdateTime — that field reflects pm-install + Play-update
        // events. The on-disk APK mtime always reflects the current
        // payload, which is what we need to invalidate cached extractions.
        File stamp = new File(root, ".apk-stamp");
        long pkgUpdate = 0L;
        try {
            String sourceDir = getApplicationInfo().sourceDir;
            if (sourceDir != null) {
                long apkMtime = new File(sourceDir).lastModified();
                if (apkMtime > 0L) pkgUpdate = apkMtime;
            }
            long pmUpdate = getPackageManager()
                .getPackageInfo(getPackageName(), 0).lastUpdateTime;
            if (pmUpdate > pkgUpdate) pkgUpdate = pmUpdate;
        } catch (Exception ignored) {
            // best-effort; no stamp known on early-boot failure
        }
        long stampedUpdate = 0L;
        if (stamp.exists()) {
            try (InputStream in = new java.io.FileInputStream(stamp)) {
                byte[] buf = new byte[64];
                int n = in.read(buf);
                if (n > 0) {
                    stampedUpdate = Long.parseLong(new String(buf, 0, n).trim());
                }
            } catch (Exception ignored) {
                // corrupt stamp — treat as missing
            }
        }
        if (pkgUpdate > 0L && pkgUpdate != stampedUpdate) {
            Log.i(TAG, "APK changed (was=" + stampedUpdate + ", now=" + pkgUpdate + "); refreshing extracted agent assets");
            File bundle = new File(root, AGENT_BUNDLE_NAME);
            if (bundle.exists() && !bundle.delete()) Log.w(TAG, "Could not delete stale agent-bundle.js");
            File launchScript = new File(root, AGENT_LAUNCH_SCRIPT);
            if (launchScript.exists() && !launchScript.delete()) Log.w(TAG, "Could not delete stale launch.sh");
            File pgWasm = new File(root, "pglite.wasm");
            if (pgWasm.exists()) pgWasm.delete();
            File initDbWasm = new File(root, "initdb.wasm");
            if (initDbWasm.exists()) initDbWasm.delete();
            File pgData = new File(root, "pglite.data");
            if (pgData.exists()) pgData.delete();
            File vec = new File(getFilesDir(), "vector.tar.gz");
            if (vec.exists()) vec.delete();
            File fuzzy = new File(getFilesDir(), "fuzzystrmatch.tar.gz");
            if (fuzzy.exists()) fuzzy.delete();
            File pluginsManifest = new File(root, "plugins-manifest.json");
            if (pluginsManifest.exists()) pluginsManifest.delete();
            File[] abiContents = abiDir.listFiles();
            if (abiContents != null) {
                for (File f : abiContents) {
                    try {
                        java.nio.file.Files.deleteIfExists(f.toPath());
                    } catch (IOException | SecurityException error) {
                        Log.w(TAG, "Could not delete stale ABI asset " + f.getName() + ": " + error.getMessage());
                    }
                }
            }
        }

        AssetManager assets = getAssets();

        copyAssetIfMissing(assets, "agent/" + AGENT_BUNDLE_NAME, new File(root, AGENT_BUNDLE_NAME));
        copyAssetIfPresent(assets, "agent/" + AGENT_LAUNCH_SCRIPT, new File(root, AGENT_LAUNCH_SCRIPT));

        // PGlite runtime assets. pglite.wasm + initdb.wasm + pglite.data
        // sit next to the bundle (`new URL("./pglite.X", import.meta.url)`);
        // vector.tar.gz and fuzzystrmatch.tar.gz must live one directory
        // ABOVE the bundle because PGlite resolves them via
        // `new URL("../X.tar.gz", ...)`.
        //
        // aapt2 quirk: even with `androidResources.noCompress` listing
        // `tar.gz` and `tar`, aapt2 strips the `.gz` suffix from
        // `*.tar.gz` assets at packaging time (the `noCompress` flag
        // only controls ZIP-level compression of the entry, not the
        // pre-processing aapt2 does to "doubly compressed" extensions).
        // The asset on disk inside the APK is therefore named
        // `vector.tar` / `fuzzystrmatch.tar`, but PGlite's runtime
        // loader still resolves `../vector.tar.gz` and
        // `../fuzzystrmatch.tar.gz`. Look up under the aapt2-rewritten
        // name and write to the runtime-expected `.tar.gz` name so the
        // loader contract is preserved without changing the bundle.
        copyAssetIfPresent(assets, "agent/pglite.wasm", new File(root, "pglite.wasm"));
        copyAssetIfPresent(assets, "agent/initdb.wasm", new File(root, "initdb.wasm"));
        copyAssetIfPresent(assets, "agent/pglite.data", new File(root, "pglite.data"));
        // aapt2 not only strips `.gz` from `*.tar.gz` asset names, it also
        // DECOMPRESSES them into raw tar bytes. PGlite's loader does
        // `new URL("../X.tar.gz", ...)` then pipes the bytes through
        // gunzip — fed raw tar it errors with `Z_DATA_ERROR: incorrect
        // header check` and the agent crashloops at PGlite init. Re-gzip
        // on extraction so the on-disk file matches what the loader
        // expects: a gzipped tarball at `vector.tar.gz` /
        // `fuzzystrmatch.tar.gz`.
        copyAssetIfPresentAsGzipped(assets, "agent/vector.tar",
            new File(getFilesDir(), "vector.tar.gz"));
        copyAssetIfPresentAsGzipped(assets, "agent/fuzzystrmatch.tar",
            new File(getFilesDir(), "fuzzystrmatch.tar.gz"));
        copyAssetIfPresent(assets, "agent/plugins-manifest.json",
            new File(root, "plugins-manifest.json"));

        // ABI-specific binaries: bun + musl loader + libstdc++ + libgcc.
        String abiAssetDir = "agent/" + abi;
        String[] abiFiles = assets.list(abiAssetDir);
        if (abiFiles == null || abiFiles.length == 0) {
            throw new IOException("APK is missing assets/" + abiAssetDir + " for runtime ABI " + abi);
        }
        for (String name : abiFiles) {
            try {
                copyAssetIfMissing(assets, abiAssetDir + "/" + name, new File(abiDir, name));
            } catch (java.io.FileNotFoundException error) {
                if ("libgcc_s.so.1".equals(name)) {
                    Log.w(TAG, "Optional runtime library missing from APK assets: " + abiAssetDir + "/" + name);
                    continue;
                }
                throw error;
            }
        }

        File bun = new File(abiDir, BUN_BINARY);
        if (bun.exists()) bun.setExecutable(true, false);
        File launch = new File(root, AGENT_LAUNCH_SCRIPT);
        if (launch.exists()) launch.setExecutable(true, false);
        for (String name : abiFiles) {
            // The musl loader (`ld-musl-<arch>.so.1`) needs +x. With the
            // SIGSYS-shim wrapper installed (x86_64 only) the original
            // Alpine loader is shipped as `ld-musl-<arch>.so.1.real` and
            // ALSO needs +x because loader-wrap execve()s it directly.
            if (name.startsWith("ld-musl-")
                && (name.endsWith(".so.1") || name.endsWith(".so.1.real"))) {
                File loader = new File(abiDir, name);
                if (loader.exists()) loader.setExecutable(true, false);
            }
        }

        boolean stdcxxLinkedFromNative = linkPackagedRuntimeLibrary(
            abiDir,
            "libstdc++.so.6",
            "libeliza_stdcpp.so"
        );
        linkPackagedRuntimeLibrary(abiDir, "libgcc_s.so.1", "libeliza_gcc_s.so");

        // bun's binary requests `libstdc++.so.6` at runtime (the soname),
        // but the actual file we shipped is the versioned realpath
        // (`libstdc++.so.6.0.33`). Without a symlink the musl loader
        // can't find the shared object and bun crashes with hundreds of
        // "Error relocating: symbol not found" lines. Create the symlink
        // pointing from the soname to the realpath inside the same abi
        // dir so LD_LIBRARY_PATH resolution works without LD_PRELOAD.
        if (!stdcxxLinkedFromNative) {
            for (String name : abiFiles) {
                if (name.startsWith("libstdc++.so.6.")) {
                    File realPath = new File(abiDir, name);
                    File symlink = new File(abiDir, "libstdc++.so.6");
                    if (realPath.exists()) {
                        try {
                            if (java.nio.file.Files.isSymbolicLink(symlink.toPath()) && !symlink.exists()) {
                                java.nio.file.Files.deleteIfExists(symlink.toPath());
                            }
                            if (!symlink.exists() && !java.nio.file.Files.isSymbolicLink(symlink.toPath())) {
                                java.nio.file.Files.createSymbolicLink(
                                    symlink.toPath(),
                                    java.nio.file.Paths.get(name)
                                );
                            }
                        } catch (IOException error) {
                            Log.w(TAG, "Could not symlink libstdc++.so.6 → " + name + ": " + error.getMessage());
                        }
                    }
                }
            }
        }

        // Bundled default models (chat + embedding GGUF files staged by
        // scripts/elizaos/stage-default-models.mjs at AOSP build time).
        // Land them under $ELIZA_STATE_DIR/local-inference/models/ so
        // the runtime's first-run bootstrap discovers them at canonical
        // paths and registers them in the local-inference registry as
        // eliza-owned models. The manifest.json carried alongside the
        // GGUF files lets the bootstrap pick the right id + role for
        // each file without re-deriving them from the filename.
        //
        // assets/agent/models/ may not exist on Capacitor (non-AOSP)
        // builds — bundling defaults to off there since the desktop /
        // Capacitor flows already have download UX. assets.list()
        // returns null on missing paths, which we treat as "no models
        // to extract".
        String modelsAssetDir = "agent/models";
        String[] modelFiles = assets.list(modelsAssetDir);
        if (modelFiles != null && modelFiles.length > 0) {
            File modelsDest = new File(
                new File(stateDir, "local-inference"),
                "models"
            );
            if (!modelsDest.exists() && !modelsDest.mkdirs()) {
                throw new IOException("Could not create " + modelsDest);
            }
            for (String name : modelFiles) {
                copyAssetIfMissing(
                    assets,
                    modelsAssetDir + "/" + name,
                    new File(modelsDest, name)
                );
            }
            Log.i(TAG, "Extracted " + modelFiles.length + " bundled model file(s) to " + modelsDest);
        }

        // Persist the APK's mtime stamp so subsequent boots can detect a
        // stale extraction and force a refresh.
        if (pkgUpdate > 0L) {
            try (FileOutputStream out = new FileOutputStream(stamp)) {
                out.write(Long.toString(pkgUpdate).getBytes());
            } catch (IOException error) {
                Log.w(TAG, "Could not write APK stamp: " + error.getMessage());
            }
        }
    }

    /** Walk agent/{abi}/ for the musl loader; name varies by ABI. */
    private String findMuslLoader(File abiDir) {
        File[] files = abiDir.listFiles();
        if (files == null) return null;
        for (File f : files) {
            String name = f.getName();
            if (name.startsWith("ld-musl-") && name.endsWith(".so.1")) {
                return name;
            }
        }
        return null;
    }

    private File nativeLibraryDir() {
        return new File(getApplicationInfo().nativeLibraryDir);
    }

    private String packagedMuslLoaderName(String abi) {
        if ("arm64-v8a".equals(abi)) return "libeliza_ld_musl_aarch64.so";
        if ("x86_64".equals(abi)) return "libeliza_ld_musl_x86_64.so";
        return null;
    }

    private File preferPackagedExecutable(File extractedFile, String packagedName) {
        File packaged = new File(nativeLibraryDir(), packagedName);
        if (packaged.exists() && packaged.length() > 0) {
            return packaged;
        }
        return extractedFile;
    }

    private boolean linkPackagedRuntimeLibrary(
        File abiDir,
        String soname,
        String packagedName
    ) {
        File packaged = new File(nativeLibraryDir(), packagedName);
        if (!packaged.exists() || packaged.length() <= 0) return false;
        File symlink = new File(abiDir, soname);
        try {
            java.nio.file.Files.deleteIfExists(symlink.toPath());
            java.nio.file.Files.createSymbolicLink(
                symlink.toPath(),
                packaged.toPath()
            );
            return true;
        } catch (IOException | UnsupportedOperationException error) {
            Log.w(TAG, "Could not symlink " + soname + " to packaged native lib: " + error.getMessage());
            return false;
        }
    }

    /**
     * Invoke `selinux.android.SELinux.restoreconRecursive` via reflection so
     * we don't take a hard compile-time dependency on the hidden API. The
     * call is best-effort: if the platform refuses it (older Android, denied
     * perm) we log and continue; the agent will run in priv_app domain and
     * the SELinux denials surface in dmesg for diagnosis.
     */
    private void relabelAgentTree(File root) {
        try {
            Class<?> selinux = Class.forName("android.os.SELinux");
            java.lang.reflect.Method restorecon = selinux.getMethod(
                "restoreconRecursive", File.class
            );
            Object result = restorecon.invoke(null, root);
            if (Boolean.FALSE.equals(result)) {
                Log.w(TAG, "SELinux.restoreconRecursive returned false for " + root);
            } else {
                Log.i(TAG, "SELinux relabel done for " + root);
            }
        } catch (ReflectiveOperationException error) {
            Log.w(TAG, "SELinux.restoreconRecursive unavailable: " + error.getMessage());
        }
    }

    private void copyAssetIfMissing(AssetManager assets, String assetPath, File target) throws IOException {
        if (target.exists() && target.length() > 0) {
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent);
        }
        try (
            InputStream in = assets.open(assetPath);
            OutputStream out = new FileOutputStream(target)
        ) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            out.flush();
        }
    }

    /**
     * Like copyAssetIfMissing, but silently no-ops when the source asset is
     * absent. Used for optional PGlite + plugin-manifest payloads; minimal
     * mobile bundles can run without those embedded database extensions.
     */
    private void copyAssetIfPresent(AssetManager assets, String assetPath, File target) throws IOException {
        try (InputStream probe = assets.open(assetPath)) {
            // present — fall through to copy via fresh stream
        } catch (IOException missing) {
            return;
        }
        copyAssetIfMissing(assets, assetPath, target);
    }

    /**
     * Like copyAssetIfPresent, but wraps the asset bytes in a gzip stream on
     * write. Compensates for aapt2's behaviour of decompressing `.tar.gz`
     * assets at packaging time even with `androidResources.noCompress`
     * declared — the on-disk APK entry is raw tar bytes, but PGlite's
     * loader does `pipeline(createReadStream(file), createGunzip(), …)`
     * and rejects raw tar with `Z_DATA_ERROR: incorrect header check`.
     * Re-gzipping on extraction restores the contract the loader expects.
     */
    private void copyAssetIfPresentAsGzipped(AssetManager assets, String assetPath, File target) throws IOException {
        try (InputStream probe = assets.open(assetPath)) {
            // present — fall through to gzip-wrap via fresh stream
        } catch (IOException missing) {
            return;
        }
        if (target.exists() && target.length() > 0) {
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent);
        }
        try (
            InputStream in = assets.open(assetPath);
            FileOutputStream raw = new FileOutputStream(target);
            java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(raw)
        ) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                gz.write(buffer, 0, read);
            }
            gz.flush();
        }
    }

    // ── Process lifecycle ────────────────────────────────────────────────

    private void requestAgentStart(boolean restartFirst) {
        synchronized (processLock) {
            if (!restartFirst && agentProcess != null && agentProcess.isAlive()) {
                return;
            }
            if (startWorker != null && startWorker.isAlive()) {
                return;
            }
            currentStatus = restartFirst ? "restarting" : "starting";
            updateNotification();
            startWorker = new Thread(() -> {
                try {
                    if (restartFirst) {
                        stopAgentProcess();
                    }
                    startAgentProcess();
                } finally {
                    synchronized (processLock) {
                        startWorker = null;
                    }
                }
            }, "ElizaAgent-start");
            startWorker.start();
        }
    }

    private void startAgentProcess() {
        synchronized (processLock) {
            if (agentProcess != null && agentProcess.isAlive()) {
                return;
            }

            String abi = resolveRuntimeAbi();
            try {
                extractAssetsIfNeeded(abi);
            } catch (IOException error) {
                Log.e(TAG, "Failed to extract agent assets for abi=" + abi, error);
                currentStatus = "extract-failed";
                updateNotification();
                return;
            }

            File root = agentRoot();
            File abiDir = agentAbiDir(abi);
            File bundle = new File(root, AGENT_BUNDLE_NAME);
            File bun = new File(abiDir, BUN_BINARY);
            String loaderName = findMuslLoader(abiDir);

            if (!bundle.exists()) {
                Log.e(TAG, "Agent bundle missing at " + bundle);
                currentStatus = "missing-bundle";
                updateNotification();
                return;
            }
            if (!bun.exists()) {
                Log.e(TAG, "bun binary missing at " + bun);
                currentStatus = "missing-bun";
                updateNotification();
                return;
            }
            if (loaderName == null) {
                Log.e(TAG, "musl loader missing under " + abiDir);
                currentStatus = "missing-loader";
                updateNotification();
                return;
            }
            File loader = new File(abiDir, loaderName);
            String packagedLoaderName = packagedMuslLoaderName(abi);
            if (packagedLoaderName != null) {
                loader = preferPackagedExecutable(loader, packagedLoaderName);
            }
            bun = preferPackagedExecutable(bun, "libeliza_bun.so");

            // Generate a fresh per-boot token for the WebView↔agent loopback.
            // Without this the loopback API would accept any local request
            // — including from other apps on the device — because the
            // agent's default isTrustedLocalRequest() heuristic treats
            // loopback as authoritative, which is wrong on multi-app
            // Android. ELIZA_REQUIRE_LOCAL_AUTH on the server side flips
            // that heuristic off so every request needs the bearer token.
            String token = generateLocalAgentToken();
            currentLocalAgentToken = token;
            try {
                writeLocalAgentTokenFile(token);
            } catch (IOException error) {
                Log.w(TAG, "Failed to persist local-agent token file: " + error.getMessage());
            }

            // Invocation:
            //   LD_LIBRARY_PATH=<agent/{abi}>  PORT=31337  ELIZA_*=…
            //   ELIZA_API_TOKEN=<token>
            //   agent/{abi}/ld-musl-…so.1  agent/{abi}/bun  agent/agent-bundle.js
            List<String> command = new ArrayList<>();
            command.add(loader.getAbsolutePath());
            command.add(bun.getAbsolutePath());
            command.add(bundle.getAbsolutePath());

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(root);
            Map<String, String> env = pb.environment();
            Map<String, String> agentEnv = new LinkedHashMap<>();
            agentEnv.put(
                "LD_LIBRARY_PATH",
                nativeLibraryDir().getAbsolutePath() + ":" + abiDir.getAbsolutePath()
            );
            agentEnv.put("PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("ELIZA_API_PORT", String.valueOf(AGENT_PORT));
            // The agent's runtime-env resolver reads ELIZA_PORT / ELIZA_UI_PORT
            // (defaulting to 2138) before falling back to PORT. Without
            // these the agent binds 2138 even though the service advertises
            // 31337, the loopback healthcheck never sees a listener, and
            // the watchdog churns indefinitely. Both env vars resolve to
            // the same port — UI bundles in the same Hono server.
            agentEnv.put("ELIZA_PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("ELIZA_UI_PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("ELIZA_STATE_DIR", agentStateDir().getAbsolutePath());
            agentEnv.put("ELIZA_PLATFORM", "android");
            agentEnv.put("ELIZA_DISABLE_DIRECT_RUN", "1");
            // Android loopback is shared across apps. Require the per-boot
            // bearer token; the Capacitor Agent plugin exposes it to the
            // WebView before local-agent API calls are retried.
            agentEnv.put("ELIZA_REQUIRE_LOCAL_AUTH", "1");
            agentEnv.put("ELIZA_API_TOKEN", token);
            // The Capacitor APK always hosts @elizaos/capacitor-llama in the
            // WebView, so the runtime should always be ready to broker
            // inference over the device-bridge WSS at /api/local-inference/
            // device-bridge. The WebView dials it over loopback once the
            // user picks the local runtime mode in onboarding.
            agentEnv.put("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
            // Skip the auto-download of recommended GGUF models that
            // mobile-device-bridge-bootstrap kicks off at registration
            // time. On Android the bun process cannot reach the network
            // without specific SELinux carve-outs and the download fail
            // cascades into a mid-init crash with no stderr captured
            // (agent.log empty, no exit code). The WebView side handles
            // model selection + persistence; the bun process only needs
            // the bridge handlers registered, not pre-warmed.
            agentEnv.put("ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD", "1");
            // AOSP builds ship libllama.so under agent/{abi}/ and load it
            // directly into the bun process via bun:ffi (see
            // eliza/packages/agent/src/runtime/aosp-llama-adapter.ts). The
            // gradle BuildConfig.AOSP_BUILD field is wired by sub-task 2B;
            // the Capacitor APK keeps its DeviceBridge loopback path.
            //
            // Also gate on `isBrandedDevice()` so the same APK can be
            // installed on stock Android (Capacitor sideload) without the
            // bun process auto-loading libllama.so. The aosp-llama-adapter
            // tries to auto-download a 1.7B GGUF from huggingface on first
            // run and bun-on-untrusted_app cannot reach the network without
            // configuration; the download fail then cascades into a
            // mid-init crash (no stderr, no exit code, agent.log empty).
            // The branded-device check uses `ro.elizaos.product` /
            // `ro.miladyos.product` system props that are only set by
            // AOSP product makefiles — stock Android leaves them empty
            // and falls through to the DeviceBridge path.
            if (BuildConfig.AOSP_BUILD && isBrandedDevice()) {
                agentEnv.put("ELIZA_LOCAL_LLAMA", "1");
                // CPU-only inference of a 12k-token prompt on cuttlefish
                // x86_64 / Eliza-1 lands well past the 180 s default
                // chat-generation timeout (chat-routes.ts). On cvd a
                // single chat turn fires the planner (9k-token prefill
                // ≈ 10 min on 4 vCPUs at 16 tok/s) plus an action
                // runner plus a reply, and the planner's structured-
                // output parser sometimes triggers a retry round.
                // Empirically end-to-end runs land at 25–45 min on cvd.
                // 60 min budget gives the smoke a full cycle to
                // complete with retries; real phone hardware
                // (Tensor / Adreno) finishes in seconds, so this only
                // matters for AOSP cvd runs.
                agentEnv.put("ELIZA_CHAT_GENERATION_TIMEOUT_MS", "3600000");

                // Eliza-1 native context is 128k. We pin to 16k
                // because 16k easily fits the planner's ~12k-token
                // prompts plus output reserve. KV-cache for 16k ctx on
                // 1B-Q4_K_M / fp16 KV is ~512 MB (16384 cells × 16 layers
                // × (256 MiB K + 256 MiB V) per llama.cpp's sched_reserve),
                // which alongside the ~770 MB weights and ~290 MB compute
                // buffer puts the model alone close to 1.6 GB. cvd has 4
                // GB total RAM with ~640 MB free at agent start, and bun's
                // heap routinely peaks at 1.5–2.0 GB during long planner
                // cycles — the combined footprint hits OOM-killer
                // territory and bun panics with a SIGSEGV mid-request.
                // Override via env on real-device builds when ctx vs RAM
                // trade-offs change.
                if (!env.containsKey("ELIZA_LLAMA_N_CTX")) {
                    agentEnv.put("ELIZA_LLAMA_N_CTX", "16384");
                }

                // Pin n_threads to the actual CPU count. The default of
                // 0 in the adapter (and llama.cpp's auto-detect path)
                // frequently returns 1 on Android because Android's
                // seccomp filter blocks sched_getaffinity for app
                // domains and llama.cpp's /proc/cpuinfo parse misses
                // the core count on cvd. Cuttlefish x86_64 has 4 vCPUs;
                // most real phones have 6–8 big.LITTLE cores. Read
                // from the JVM at startup and pass through so the FFI
                // side doesn't need to call any blocked syscall.
                if (!env.containsKey("ELIZA_LLAMA_THREADS")) {
                    int cores = Runtime.getRuntime().availableProcessors();
                    if (cores < 1) cores = 1;
                    agentEnv.put("ELIZA_LLAMA_THREADS", String.valueOf(cores));
                }

                // Smaller decode chunks → more event-loop yield points
                // during prompt prefill. 2048 holds bun inside a single
                // llama_decode call for ~30 s on cvd CPU; the watchdog
                // probe sits on a closed listener queue that whole
                // time. 512-token chunks land each call in ~6–8 s, so
                // the 30 s probe timeout has a realistic chance to
                // wake the listener between chunks.
                if (!env.containsKey("ELIZA_LLAMA_N_BATCH")) {
                    agentEnv.put("ELIZA_LLAMA_N_BATCH", "512");
                }
            }
            agentEnv.put("HOME", getFilesDir().getAbsolutePath());
            agentEnv.put("TMPDIR", getCacheDir().getAbsolutePath());

            // ── No-terminal env hints for bun's stdio probe ───────────────
            // Untrusted-app SELinux policy denies `ioctl(TIOCGWINSZ)` on
            // both app_data_file and the Java-pipe fifo with `permissive=0`.
            // Bun's stdio init calls `ioctl(stdout, TIOCGWINSZ)` to detect
            // terminal width; on EACCES it has historically returned mid-
            // init without writing any diagnostic, leaving agent.log empty
            // and the watchdog probing a non-existent listener. The env
            // hints below put bun on its non-terminal path so it does not
            // bother probing — TERM=dumb gates the terminfo lookups,
            // NO_COLOR=1 + FORCE_COLOR=0 disable the ANSI emitter, and
            // CI=1 routes through bun's CI-mode logger (no progress bars,
            // no spinners, no width detection).
            agentEnv.put("TERM", "dumb");
            agentEnv.put("NO_COLOR", "1");
            agentEnv.put("FORCE_COLOR", "0");
            agentEnv.put("CI", "1");

            // ── Android seccomp compatibility (SIGSYS / code 159 fix) ──────
            //
            // Android's zygote installs a seccomp-bpf filter on every app
            // process via `seccomp_set_policy()` in
            // frameworks/base/core/jni/com_android_internal_os_Zygote.cpp,
            // sourced from the per-arch allowlists in
            // bionic/libc/seccomp/{x86_64,arm64}_app_policy.cpp. The filter is
            // inherited and locked by SECCOMP_FILTER_FLAG_TSYNC; a child
            // process spawned via fork+execve (which is how this service
            // launches bun via ProcessBuilder) cannot opt out. SELinux
            // policy in vendor/eliza/sepolicy/ is orthogonal — it does
            // not (and cannot) override seccomp.
            //
            // Bun's Linux runtime exercises several syscalls that Android's
            // seccomp filter blocks for app domains:
            //   - `io_uring_setup` / `io_uring_enter` / `io_uring_register`
            //     (bun's IO pool; not on Android's app allowlist)
            //   - `pidfd_open` (bun uses it for child-process waiting; not
            //     on the app allowlist before Android 13 / API 33, and
            //     gated behind `pidfd_open` allow on newer policy)
            //   - `preadv2` / `pwritev2` with `RWF_NONBLOCK` (bun's
            //     async-fs path; some Android kernels gate the flag arg)
            //
            // Empirically the agent bundle exit-trapped on SIGSYS (signal
            // 31, exit code 128 + 31 = 159) at first interpretation of
            // user code. The four BUN_FEATURE_FLAG_* knobs below opt bun
            // into its more conservative fallbacks for each of those
            // syscalls. They are intentionally redundant: enabling all four
            // costs nothing and protects against future bun versions that
            // start using a previously-unused gated syscall.
            //
            // BUN_FEATURE_FLAG_DISABLE_IO_POOL=1
            //     Replaces bun's io_uring-backed IO pool with the legacy
            //     thread-pool implementation. Avoids io_uring_* entirely.
            //
            // BUN_FEATURE_FLAG_FORCE_WAITER_THREAD=1
            //     Forces the dedicated waiter-thread child reaper instead
            //     of pidfd_open + epoll. Avoids pidfd_open.
            //
            // BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK=1
            //     Drops RWF_NONBLOCK from preadv2/pwritev2 calls so bun
            //     stays on flags Android's seccomp predates. Costs us
            //     nothing on Android (the kernel runs the same fallback).
            //
            // BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH=1
            //     Forces bun's portable spawn fast path off so any
            //     vfork/clone3 variants the seccomp filter blocks aren't
            //     attempted.
            //
            // To diagnose a future SIGSYS regression on a real boot:
            //   adb logcat -d | grep -E '(SIGSYS|seccomp|audit:.*type=1326)'
            //   adb shell dmesg | grep -E '(seccomp|SIGSYS)'
            // The audit line includes `syscall=N`; map it via
            //   bionic/libc/kernel/uapi/asm-generic/unistd.h or
            //   https://chromium.googlesource.com/aosp/platform/bionic/+/refs/heads/master/libc/SYSCALLS.TXT
            // and either add a new BUN_FEATURE_FLAG_* knob or open a bun
            // issue if the call has no fallback.
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_IO_POOL", "1");
            agentEnv.put("BUN_FEATURE_FLAG_FORCE_WAITER_THREAD", "1");
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK", "1");
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH", "1");
            // BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER=1
            //     Forces bun's transpiler to run on the main thread
            //     instead of the async worker pool. The worker pool
            //     uses pthread + futex_waitv (added in 5.16) which
            //     Android's app seccomp policy blocks on most kernels
            //     before API 34. Disables the worker thread spawn
            //     entirely — the transpiler still runs, just inline.
            //
            // NOTE: Do NOT set BUN_FEATURE_FLAG_DISABLE_MEMFD=1 here.
            // memfd_create IS on Android's app seccomp allowlist
            // (verified API 30+), and bun's JSC tier uses memfd as
            // the W^X dual-mapping mechanism for JIT code pages.
            // Disabling memfd forces JSC to fall back to raw RWX
            // mmap, which IS blocked by SELinux execmem on platform_app
            // — that combination kills bun before any log line is
            // written. Tested empirically: with the 43 MB agent-bundle,
            // DISABLE_MEMFD=1 produces an early SIGSYS during JIT init;
            // with memfd allowed, bun reaches PGlite + listener.
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER", "1");

            // ── No on-device prompt-optimization / training ────────────
            //
            // The runtime ships with a trajectory-driven prompt-optimization
            // pipeline (MIPRO / GEPA / bootstrap-fewshot via the native
            // backend). On boot, OptimizedPromptService kicks off a one-
            // shot bootstrap when accumulated trajectories cross threshold,
            // and the cron auto-trainer dispatches further rounds in the
            // background. None of that belongs on a phone or a privileged
            // system app:
            //   - MIPRO/GEPA spawn coding sub-agents (PTY-backed bash) that
            //     blow past the bun seccomp envelope this service builds.
            //   - The trajectory writer fans out to the trajectories table
            //     under PGlite which already churns the device flash.
            //   - On AOSP cvd we want a deterministic agent binary, not
            //     one that mutates its prompts mid-smoke.
            //
            // Hard-disable both the bootstrap and the trajectory ingest
            // path so the agent never spins up a training round on-device.
            // Trajectories are still useful for live chat context, but
            // this disables PERSISTENCE — the optimizer has no input data
            // and no-ops at boot.
            agentEnv.put("ELIZA_DISABLE_AUTO_BOOTSTRAP", "1");
            agentEnv.put("ELIZA_DISABLE_TRAJECTORY_LOGGING", "1");

            // ── Vault passphrase ──────────────────────────────────────
            // The runtime's vault-bootstrap mirrors process.env secrets
            // through @elizaos/vault, which on a headless Linux host
            // (Android counts: no reachable D-Bus session) refuses the
            // OS keychain and demands ELIZA_VAULT_PASSPHRASE (≥12 chars)
            // to derive a master key. Without it the bootstrap fails
            // and startEliza() throws "[vault-bootstrap] all 1 secret
            // writes failed; vault unreachable", which the watchdog
            // interprets as a crash and restart-loops the agent.
            //
            // Derive a per-install stable passphrase from ANDROID_ID
            // (Settings.Secure.ANDROID_ID — 16 hex chars, per-app-install
            // on Android 8+, stable across reboots and OS updates).
            // Prefix with a constant so the value is always ≥12 chars
            // even if ANDROID_ID is unexpectedly short or null. The
            // resulting passphrase is opaque to the user and is only
            // ever stored in memory in the spawned bun process.
            //
            // Operators can override by setting ELIZA_VAULT_PASSPHRASE
            // in the parent service env (e.g. for a deterministic dev
            // passphrase across reinstalls).
            if (!env.containsKey("ELIZA_VAULT_PASSPHRASE")) {
                String androidId = Settings.Secure.getString(
                    getContentResolver(),
                    Settings.Secure.ANDROID_ID
                );
                if (androidId == null || androidId.length() < 8) {
                    androidId = "fallback-" + Build.SERIAL;
                }
                agentEnv.put(
                    "ELIZA_VAULT_PASSPHRASE",
                    "elizaos-android-vault-" + androidId
                );
            }

            // Default to info-level logging so plugin resolution + listen
            // progress is visible in agent.log. The runtime defaults to
            // `error` which leaves boot hangs invisible. Operators can
            // override by setting LOG_LEVEL in the parent service env.
            if (!env.containsKey("LOG_LEVEL")) {
                agentEnv.put("LOG_LEVEL", "info");
            }

            env.putAll(agentEnv);

            // ── Stdio redirection (TIOCGWINSZ SELinux workaround) ─────────
            // On Android `untrusted_app`, SELinux denies
            // `ioctl(fd, TIOCGWINSZ)` (cmd 0x5413) on every non-tty class
            // accessible to the app with `permissive=0`:
            //   - `pipe:[...]` (Java ProcessBuilder PIPE) → fifo_file ioctl
            //   - `/data/data/<pkg>/files/agent/agent.log` → app_data_file ioctl
            // The denial returns EACCES; bun's stdio init (or musl's
            // `__init_libc` terminal-width probe) treats the EACCES as a
            // hard failure and exits within ~100ms before any line is
            // flushed, leaving agent.log at 0 bytes and the watchdog
            // probing nothing. The one fd class that *does* allow ioctl
            // for untrusted_app is `null_device:chr_file` (rw_file_perms
            // grants ioctl, no xperm whitelist restriction). Verified
            // empirically: same ProcessBuilder spawn from `runas_app`
            // context (more permissive) reaches `/api/health 200`;
            // identical spawn from `untrusted_app` (service context)
            // dies silently on the file ioctl.
            //
            // Workaround: redirect all three fds to /dev/null so every
            // TIOCGWINSZ returns ENOTTY (kernel-level, no SELinux check
            // needed). We sacrifice stdout/stderr capture for liveness;
            // the agent runtime still writes structured logs to
            // `<stateDir>/logs/agent.log` via its own pino transport,
            // and Android's logcat captures every line emitted via
            // `Log.i(TAG, …)` from the Java side. For local debug
            // sessions that need raw bun stdio, set `ELIZA_LOG_STDOUT=1`
            // in the parent service env — that opts into the legacy
            // file-redirect path (which only works on rooted devices
            // or via `adb shell run-as`).
            File devNull = new File("/dev/null");
            pb.redirectInput(ProcessBuilder.Redirect.from(devNull));
            if ("1".equals(System.getenv("ELIZA_LOG_STDOUT"))) {
                pb.redirectErrorStream(true);
                File logFile = new File(root, AGENT_LOG_NAME);
                pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile));
            } else {
                pb.redirectErrorStream(true);
                pb.redirectOutput(ProcessBuilder.Redirect.to(devNull));
            }

            Process started;
            try {
                started = pb.start();
            } catch (IOException error) {
                Log.e(TAG, "Failed to spawn agent process: " + command, error);
                currentStatus = "spawn-failed";
                updateNotification();
                scheduleRestart();
                return;
            }

            agentProcess = started;
            // stdoutPump/stderrPump no longer needed — bun writes straight
            // to agent.log on disk via the OS-level redirect above.
            stdoutPump = null;
            stderrPump = null;
            currentStatus = "running";
            updateNotification();
            final long startedAtMs = System.currentTimeMillis();
            final long pidForLog = safePid(started);
            Log.i(TAG, "Agent process started (pid=" + pidForLog + ").");
            // Immediate-exit watcher: bun on `untrusted_app` has been
            // observed dying within ~50ms with no stderr / no tombstone /
            // no audit hint past the standard musl init probe denials.
            // The 10-minute watchdog tick is far too slow to surface a
            // useful exit code. This thread blocks on `process.waitFor()`
            // and logs the exit value the moment the kernel reaps the
            // child, then hands off to the existing watchdog restart
            // path via scheduleRestart().
            final Process watched = started;
            Thread exitWatcher = new Thread(() -> {
                int code;
                try {
                    code = watched.waitFor();
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    return;
                }
                long aliveMs = System.currentTimeMillis() - startedAtMs;
                Log.w(TAG, "Agent process exited early (pid=" + pidForLog
                        + " code=" + code + " alive=" + aliveMs + "ms).");
                boolean stillThisProcess;
                synchronized (processLock) {
                    stillThisProcess = (agentProcess == watched);
                    if (stillThisProcess) {
                        agentProcess = null;
                    }
                }
                if (stillThisProcess && !shuttingDown) {
                    scheduleRestart();
                }
            }, "ElizaAgent-exit-watcher");
            exitWatcher.setDaemon(true);
            exitWatcher.start();
        }
    }

    private void stopAgentProcess() {
        Process toStop;
        Thread outPump;
        Thread errPump;
        synchronized (processLock) {
            toStop = agentProcess;
            outPump = stdoutPump;
            errPump = stderrPump;
            agentProcess = null;
            stdoutPump = null;
            stderrPump = null;
        }
        if (toStop == null) {
            return;
        }
        Log.i(TAG, "Stopping agent process (pid=" + safePid(toStop) + ").");
        toStop.destroy();
        long deadline = System.currentTimeMillis() + PROCESS_TERMINATE_GRACE_MS;
        while (toStop.isAlive() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        if (toStop.isAlive()) {
            Log.w(TAG, "Agent did not exit on SIGTERM — sending SIGKILL.");
            toStop.destroyForcibly();
        }
        if (outPump != null) outPump.interrupt();
        if (errPump != null) errPump.interrupt();
    }

    private static final java.security.SecureRandom TOKEN_RNG = new java.security.SecureRandom();

    private static String generateLocalAgentToken() {
        byte[] bytes = new byte[32];
        TOKEN_RNG.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    /**
     * Persist the per-boot token to a UID-restricted file so a future
     * restart of the WebView (without restarting the service) can re-read
     * it without losing auth. File is mode 0600; only the app's own UID
     * can read.
     */
    private void writeLocalAgentTokenFile(String token) throws IOException {
        File dir = new File(getFilesDir(), "auth");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir);
        }
        File file = new File(dir, "local-agent-token");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(token.getBytes());
        }
        file.setReadable(false, false);
        file.setReadable(true, true);
        file.setWritable(false, false);
        file.setWritable(true, true);
    }

    private long safePid(Process process) {
        // Process#pid() is Java 9+; Android's java.lang.Process exposes it
        // since API 24. AGP's d8 desugaring on this project rejects the
        // direct call at compile time even with sourceCompatibility=21,
        // so go through reflection — pid is informational only.
        try {
            Object value = Process.class.getMethod("pid").invoke(process);
            return value instanceof Long ? (Long) value : -1L;
        } catch (ReflectiveOperationException | UnsupportedOperationException ignored) {
            return -1L;
        }
    }

    /**
     * Drain a process stream into the agent log file and tee to logcat.
     * One thread per stream; both exit cleanly when the stream closes
     * (process death) or the thread is interrupted.
     */
    private Thread startStreamPump(InputStream stream, File logFile, String label) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[4096];
            try (FileOutputStream logOut = new FileOutputStream(logFile, true)) {
                // Buffer raw bytes until '\n' so multi-byte UTF-8 sequences
                // are decoded intact — newline (0x0A) never appears as a
                // continuation byte in UTF-8, so splitting on it can't slice
                // a codepoint. A char-level StringBuilder with `(char)(byte
                // & 0xFF)` would mojibake non-ASCII output (emoji, CJK).
                ByteArrayOutputStream lineBuf = new ByteArrayOutputStream(256);
                int n;
                // Interrupt check goes before read(): once read() has
                // returned bytes we're committed to writing them, otherwise
                // a graceful-shutdown interrupt during a successful read
                // would silently drop the very tail this PR exists to save.
                while (!Thread.currentThread().isInterrupted() && (n = stream.read(buf)) >= 0) {
                    // Mirror raw bytes to the log immediately so a mid-write
                    // panic in the agent doesn't lose its last diagnostic.
                    // BufferedReader.readLine() dropped partial lines on
                    // crash; the byte-level pump captures everything.
                    logOut.write(buf, 0, n);
                    logOut.flush();
                    // For logcat readability, accumulate complete lines and
                    // emit them tagged. The post-loop drain below handles the
                    // unterminated tail when the stream closes mid-line.
                    for (int i = 0; i < n; i += 1) {
                        byte b = buf[i];
                        if (b == (byte) '\n') {
                            if (lineBuf.size() > 0) {
                                String line = lineBuf.toString(StandardCharsets.UTF_8.name());
                                lineBuf.reset();
                                // Strip a trailing '\r' from CRLF without
                                // a separate scan over `line`.
                                if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
                                if (!line.isEmpty()) Log.i(TAG, line);
                            }
                        } else {
                            lineBuf.write(b);
                        }
                    }
                }
                if (lineBuf.size() > 0) {
                    String tail = lineBuf.toString(StandardCharsets.UTF_8.name());
                    Log.w(TAG, tail + " <eof — no trailing newline>");
                }
            } catch (IOException error) {
                if (!shuttingDown) {
                    Log.w(TAG, "Stream pump (" + label + ") ended.", error);
                }
            }
        }, "ElizaAgent-pump-" + label);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private void scheduleRestart() {
        if (shuttingDown) return;
        if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
            Log.e(TAG, "Agent crashed " + restartAttempts + " times — giving up. Service stopping.");
            currentStatus = "fatal";
            updateNotification();
            stopSelf();
            return;
        }
        long backoffMs = 1000L * (1L << restartAttempts);
        restartAttempts++;
        Log.w(TAG, "Restarting agent in " + backoffMs + "ms (attempt " + restartAttempts + "/" + MAX_RESTART_ATTEMPTS + ").");
        new Thread(() -> {
            try {
                Thread.sleep(backoffMs);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
            if (shuttingDown) return;
            startAgentProcess();
        }, "ElizaAgent-restart").start();
    }

    // ── Watchdog ─────────────────────────────────────────────────────────

    /**
     * Polls the agent process and the local health endpoint every
     * {@link #WATCHDOG_INTERVAL_MS}. If the process died, schedule a
     * restart with exponential backoff. If the process is alive but the
     * health endpoint has been unreachable for two consecutive ticks,
     * also force a restart — the runtime is wedged.
     */
    private final class WatchdogThread extends Thread {
        private int unhealthyTicks;

        WatchdogThread() {
            super("ElizaAgent-watchdog");
            setDaemon(true);
        }

        @Override
        public void run() {
            while (!shuttingDown && !isInterrupted()) {
                try {
                    Thread.sleep(WATCHDOG_INTERVAL_MS);
                } catch (InterruptedException error) {
                    return;
                }
                if (shuttingDown) return;

                Process current;
                synchronized (processLock) {
                    current = agentProcess;
                }
                if (current == null) {
                    // Service is up but no process — caller must explicitly start.
                    continue;
                }
                if (!current.isAlive()) {
                    int exit = -1;
                    try {
                        exit = current.exitValue();
                    } catch (IllegalThreadStateException ignored) {
                        // Race: marked alive between checks. Treat as dead.
                    }
                    Log.w(TAG, "Agent process exited (code=" + exit + "). Scheduling restart.");
                    synchronized (processLock) {
                        agentProcess = null;
                    }
                    unhealthyTicks = 0;
                    scheduleRestart();
                    continue;
                }

                ProbeResult probe = probeHealth();
                if (probe == ProbeResult.OK) {
                    if (unhealthyTicks > 0) {
                        Log.i(TAG, "Agent health restored.");
                    }
                    unhealthyTicks = 0;
                    if (restartAttempts > 0) {
                        // Reset backoff once the agent has been healthy for a tick.
                        restartAttempts = 0;
                    }
                    if (!"running".equals(currentStatus)) {
                        currentStatus = "running";
                        updateNotification();
                    }
                } else if (probe == ProbeResult.BUSY) {
                    // HTTP listener didn't answer in HEALTH_TIMEOUT_MS but the
                    // bun process is still alive. The most likely cause is
                    // synchronous work inside the JS event loop — typically
                    // a long llama_decode FFI call with a 12k-token prompt
                    // on emulated CPU. We do NOT count a strike; the
                    // process is doing exactly what it should be doing.
                    // Logging is at info-level so operators can correlate
                    // decode-busy periods with apparent unresponsiveness.
                    Log.i(TAG, "Agent HTTP probe timed out but process is alive — likely mid-decode. No strike.");
                } else {
                    // ProbeResult.DEAD: process is dead, OR /api/health
                    // returned 5xx (a real crash signal). Only here do we
                    // accumulate strikes toward a force-restart.
                    unhealthyTicks++;
                    Log.w(TAG, "Agent health probe failed (" + unhealthyTicks + " consecutive).");
                    if (unhealthyTicks >= HEALTH_FAIL_STRIKES) {
                        unhealthyTicks = 0;
                        Log.w(TAG, "Agent unresponsive — force-restarting.");
                        stopAgentProcess();
                        scheduleRestart();
                    }
                }
            }
        }

        private ProbeResult probeHealth() {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(HEALTH_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout((int) HEALTH_TIMEOUT_MS);
                conn.setReadTimeout((int) HEALTH_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                int status = conn.getResponseCode();
                if (status >= 200 && status < 500) {
                    return ProbeResult.OK;
                }
                // 5xx: agent process is up but reported a server error.
                // Treat as DEAD so strikes accumulate — a 5xx on
                // /api/health is a crash signal, not a busy signal.
                return ProbeResult.DEAD;
            } catch (IOException error) {
                // HTTP request failed (timeout / connect refused / read
                // interrupt). If the agent process is still alive the
                // most likely cause is bun synchronously inside a native
                // FFI call (long llama_decode on a multi-thousand-token
                // prompt). The event loop will resume when the FFI call
                // returns. If the process IS dead, scheduleRestart()
                // already fired from the outer loop on the
                // !current.isAlive() path on the previous tick — a
                // strike here would be redundant.
                Process current;
                synchronized (processLock) {
                    current = agentProcess;
                }
                if (current != null && current.isAlive()) {
                    return ProbeResult.BUSY;
                }
                return ProbeResult.DEAD;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    /**
     * Outcome of a single watchdog health probe. The watchdog uses these
     * to decide whether to count a strike toward force-restart:
     *   OK   → process is healthy, reset strike counter.
     *   BUSY → process is alive but the HTTP listener didn't answer in
     *          HEALTH_TIMEOUT_MS. Typically means bun is synchronously
     *          inside a native FFI call (llama_decode on a long prompt).
     *          No strike.
     *   DEAD → process is dead, OR the HTTP server returned 5xx, OR a
     *          hard connection failure (port closed). Count a strike.
     */
    private enum ProbeResult {
        OK,
        BUSY,
        DEAD,
    }

    // ── Notification helpers ─────────────────────────────────────────────

    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Eliza Agent",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Local Eliza agent runtime status");
        channel.setShowBadge(false);

        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) {
            mgr.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String title, String text) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPending = PendingIntent.getActivity(
            this, 1, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, ElizaAgentService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(launchPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Stop", stopPending)
            .build();
    }

    private void updateNotification() {
        String title;
        String text;
        switch (currentStatus) {
            case "running":
                title = "Eliza agent · Running";
                text = "Local agent listening on :" + AGENT_PORT;
                break;
            case "starting":
                title = "Eliza agent · Starting";
                text = "Preparing on-device runtime…";
                break;
            case "fatal":
                title = "Eliza agent · Stopped";
                text = "Agent crashed repeatedly; tap to investigate";
                break;
            case "extract-failed":
                title = "Eliza agent · Asset error";
                text = "Could not unpack runtime";
                break;
            case "missing-bundle":
            case "missing-bun":
            case "missing-loader":
                title = "Eliza agent · Missing files";
                text = currentStatus;
                break;
            case "spawn-failed":
                title = "Eliza agent · Spawn failed";
                text = "Could not start runtime process";
                break;
            default:
                title = "Eliza agent";
                text = currentStatus;
                break;
        }

        Notification notification = buildNotification(title, text);
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.notify(NOTIFICATION_ID, notification);
        }
    }

    // ── Static helpers for callers ───────────────────────────────────────

    /**
     * SharedPreferences group used by Capacitor's @capacitor/preferences
     * plugin. Mirrors PreferencesConfiguration.DEFAULTS.group in v8.
     */
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";

    /**
     * Storage key for the persisted mobile runtime mode. Must match
     * MOBILE_RUNTIME_MODE_STORAGE_KEY in
     * eliza/packages/app-core/src/onboarding/mobile-runtime-mode.ts.
     */
    private static final String RUNTIME_MODE_KEY = "eliza:mobile-runtime-mode";

    /**
     * Whether the on-device agent should auto-start at app boot.
     *
     * - On AOSP / ElizaOS-branded devices (`ro.elizaos.product` set or any
     *   white-label fork's `ro.<brand>os.product`), the device IS the
     *   agent: always start.
     * - On stock Android, only start when the user has explicitly picked
     *   the Local runtime in the onboarding picker (mobile-runtime-mode
     *   == "local"). Cloud and Remote modes do not need this service.
     */
    public static boolean shouldAutoStart(Context context) {
        if (isBrandedDevice()) {
            return true;
        }
        String mode = readRuntimeMode(context);
        return "local".equals(mode);
    }

    private static boolean isBrandedDevice() {
        if (!readSystemProperty("ro.elizaos.product").isEmpty()) return true;
        // White-label forks set ro.<brand>os.product (e.g. ro.miladyos.product).
        // We can't enumerate every fork's namespace from native code, so
        // probe the most common ones used by current forks. Forks that
        // need a different sysprop should override shouldAutoStart locally.
        return !readSystemProperty("ro.miladyos.product").isEmpty();
    }

    private static String readRuntimeMode(Context context) {
        try {
            return context
                .getSharedPreferences(CAPACITOR_PREFS_GROUP, Context.MODE_PRIVATE)
                .getString(RUNTIME_MODE_KEY, null);
        } catch (Exception e) {
            Log.w(TAG, "Unable to read runtime mode preference", e);
            return null;
        }
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            java.lang.reflect.Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            return "";
        }
    }

    /** Start the foreground service (safe to call repeatedly). */
    public static void start(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    /** Request a graceful stop via the ACTION_STOP intent. */
    public static void stop(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    /** Restart the agent process without tearing down the service. */
    public static void restart(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_RESTART);
        context.startService(intent);
    }

    /** Push a status string into the foreground notification. */
    public static void updateStatus(Context context, String status) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_UPDATE_STATUS);
        intent.putExtra(EXTRA_STATUS, status);
        context.startService(intent);
    }
}

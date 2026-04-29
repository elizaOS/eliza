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
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
public class MiladyAgentService extends Service {

    private static final String TAG = "MiladyAgent";

    private static final String CHANNEL_ID = "milady_agent";
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
    //   .milady/                   ← MILADY_STATE_DIR (PGlite data, auth, prompts)
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
    private static final String AGENT_STATE_DIR_NAME = ".milady";
    private static final String AGENT_BUNDLE_NAME = "agent-bundle.js";
    private static final String AGENT_LAUNCH_SCRIPT = "launch.sh";
    private static final String BUN_BINARY = "bun";
    private static final String AGENT_LOG_NAME = "agent.log";

    private static final int AGENT_PORT = 31337;
    private static final String HEALTH_URL = "http://127.0.0.1:" + AGENT_PORT + "/api/health";

    // The on-device boot path is heavy: PGlite extension extraction +
    // plugin resolution + libllama dlopen + first-time model load can
    // exceed 240 s on a cold cuttlefish x86_64 image. With the watchdog
    // at 10 s, two consecutive misses (20 s) kill bun before PGlite
    // finishes opening the database. The agent-bundle's own
    // "coordinator not available after 90s (boot)" debug line is also
    // misleading — the real `[eliza-api] Listening` print happens
    // ~200–240 s after process start on cvd.
    //
    // 120 s × 3 = 360 s grace gives enough headroom. We override the
    // 2-strike rule below to 3 strikes for the same reason. Tighten back
    // down once a runtime "ready" signal lands.
    //
    // HEALTH_TIMEOUT_MS = 120 s: bun blocks on FFI calls into libllama
    // for the duration of a single `llama_decode` call (no way to
    // interrupt a native call from JS). On cuttlefish x86_64 with
    // SmolLM2-360M and an 8k-context prompt chunked at n_batch=2048, one
    // chunk decode runs ~60–70 s. A 3 s probe timeout would fire mid-
    // decode, never hear back, and rack up strikes that kill bun before
    // it returns to the event loop. Bumping the per-probe timeout above
    // worst-case decode latency lets the probe sit on the connect/read
    // socket until bun's setImmediate yield wakes the HTTP listener.
    private static final long WATCHDOG_INTERVAL_MS = 120_000L;
    private static final int HEALTH_FAIL_STRIKES = 3;
    private static final long HEALTH_TIMEOUT_MS = 120_000L;
    private static final int MAX_RESTART_ATTEMPTS = 5;
    private static final long PROCESS_TERMINATE_GRACE_MS = 5_000L;

    private final Object processLock = new Object();
    private Process agentProcess;
    private Thread stdoutPump;
    private Thread stderrPump;
    private WatchdogThread watchdog;
    private volatile boolean shuttingDown;
    private int restartAttempts;
    private String currentStatus = "starting";

    // Per-boot bearer token for the WebView↔agent loopback. Generated when
    // the service first starts the agent process and cleared on stop.
    // The Capacitor agent plugin reads it from `localAgentToken()` to
    // hydrate `window.__ELIZA_API_TOKEN__` so the WebView's fetches
    // include `Authorization: Bearer <token>`. The agent enforces the
    // token via MILADY_REQUIRE_LOCAL_AUTH=1.
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

        Notification notification = buildNotification("Milady agent", "Starting…");

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
            stopAgentProcess();
            startAgentProcess();
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
        synchronized (processLock) {
            if (agentProcess == null || !agentProcess.isAlive()) {
                startAgentProcess();
            }
        }
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
                    if (f.isFile() && !f.delete()) Log.w(TAG, "Could not delete " + f.getName());
                }
            }
        }

        AssetManager assets = getAssets();

        copyAssetIfMissing(assets, "agent/" + AGENT_BUNDLE_NAME, new File(root, AGENT_BUNDLE_NAME));
        copyAssetIfPresent(assets, "agent/" + AGENT_LAUNCH_SCRIPT, new File(root, AGENT_LAUNCH_SCRIPT));

        // PGlite runtime assets. pglite.wasm + pglite.data sit next to
        // the bundle (`new URL("./pglite.X", import.meta.url)`);
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
            copyAssetIfMissing(assets, abiAssetDir + "/" + name, new File(abiDir, name));
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

        // bun's binary requests `libstdc++.so.6` at runtime (the soname),
        // but the actual file we shipped is the versioned realpath
        // (`libstdc++.so.6.0.33`). Without a symlink the musl loader
        // can't find the shared object and bun crashes with hundreds of
        // "Error relocating: symbol not found" lines. Create the symlink
        // pointing from the soname to the realpath inside the same abi
        // dir so LD_LIBRARY_PATH resolution works without LD_PRELOAD.
        for (String name : abiFiles) {
            if (name.startsWith("libstdc++.so.6.")) {
                File realPath = new File(abiDir, name);
                File symlink = new File(abiDir, "libstdc++.so.6");
                if (realPath.exists() && !symlink.exists()) {
                    try {
                        java.nio.file.Files.createSymbolicLink(
                            symlink.toPath(),
                            java.nio.file.Paths.get(name)
                        );
                    } catch (IOException error) {
                        Log.w(TAG, "Could not symlink libstdc++.so.6 → " + name + ": " + error.getMessage());
                    }
                }
            }
        }

        // Bundled default models (chat + embedding GGUF files staged by
        // scripts/miladyos/stage-default-models.mjs at AOSP build time).
        // Land them under $MILADY_STATE_DIR/local-inference/models/ so
        // the runtime's first-run bootstrap discovers them at canonical
        // paths and registers them in the local-inference registry as
        // milady-owned models. The manifest.json carried alongside the
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
     * absent. Used for PGlite + plugin-manifest payload that Phase D
     * generates only when the real agent bundle is built; with the spike
     * placeholder bundle the assets are simply not present and the agent
     * runs without them.
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

            // Generate a fresh per-boot token for the WebView↔agent loopback.
            // Without this the loopback API would accept any local request
            // — including from other apps on the device — because the
            // agent's default isTrustedLocalRequest() heuristic treats
            // loopback as authoritative, which is wrong on multi-app
            // Android. MILADY_REQUIRE_LOCAL_AUTH on the server side flips
            // that heuristic off so every request needs the bearer token.
            String token = generateLocalAgentToken();
            currentLocalAgentToken = token;
            try {
                writeLocalAgentTokenFile(token);
            } catch (IOException error) {
                Log.w(TAG, "Failed to persist local-agent token file: " + error.getMessage());
            }

            // Invocation:
            //   LD_LIBRARY_PATH=<agent/{abi}>  PORT=31337  MILADY_*=…
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
            agentEnv.put("LD_LIBRARY_PATH", abiDir.getAbsolutePath());
            agentEnv.put("PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("MILADY_API_PORT", String.valueOf(AGENT_PORT));
            // The agent's runtime-env resolver reads ELIZA_PORT / ELIZA_UI_PORT
            // (defaulting to 2138) before falling back to PORT. Without
            // these the agent binds 2138 even though the service advertises
            // 31337, the loopback healthcheck never sees a listener, and
            // the watchdog churns indefinitely. Both env vars resolve to
            // the same port — UI bundles in the same Hono server.
            agentEnv.put("ELIZA_PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("ELIZA_UI_PORT", String.valueOf(AGENT_PORT));
            agentEnv.put("MILADY_STATE_DIR", agentStateDir().getAbsolutePath());
            agentEnv.put("MILADY_PLATFORM", "android");
            agentEnv.put("MILADY_DISABLE_DIRECT_RUN", "1");
            agentEnv.put("MILADY_REQUIRE_LOCAL_AUTH", "1");
            agentEnv.put("ELIZA_API_TOKEN", token);
            // The Capacitor APK always hosts @elizaos/capacitor-llama in the
            // WebView, so the runtime should always be ready to broker
            // inference over the device-bridge WSS at /api/local-inference/
            // device-bridge. The WebView dials it over loopback once the
            // user picks the local runtime mode in onboarding.
            agentEnv.put("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
            // AOSP builds ship libllama.so under agent/{abi}/ and load it
            // directly into the bun process via bun:ffi (see
            // eliza/packages/agent/src/runtime/aosp-llama-adapter.ts). The
            // gradle BuildConfig.AOSP_BUILD field is wired by sub-task 2B;
            // the Capacitor APK keeps its DeviceBridge loopback path.
            if (BuildConfig.AOSP_BUILD) {
                agentEnv.put("MILADY_LOCAL_LLAMA", "1");
                // CPU-only inference of an 8k-context prompt on cuttlefish
                // x86_64 / SmolLM2-360M lands well past the 180 s default
                // chat-generation timeout (chat-routes.ts). 30 minutes
                // covers prompt decode (≈4 chunks × ~70 s + ramp-up) plus
                // token generation. Real phone hardware (Tensor / Adreno)
                // finishes in seconds, so this only matters for AOSP
                // smoke runs on cvd. Override via env on real-device
                // builds when first-token-latency lands.
                agentEnv.put(
                    "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
                    "1800000");
            }
            agentEnv.put("HOME", getFilesDir().getAbsolutePath());
            agentEnv.put("TMPDIR", getCacheDir().getAbsolutePath());

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
            // policy in vendor/milady/sepolicy/ is orthogonal — it does
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

            // Default to info-level logging so plugin resolution + listen
            // progress is visible in agent.log. The runtime defaults to
            // `error` which leaves boot hangs invisible. Operators can
            // override by setting LOG_LEVEL in the parent service env.
            if (!env.containsKey("LOG_LEVEL")) {
                agentEnv.put("LOG_LEVEL", "info");
            }

            env.putAll(agentEnv);

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
            File logFile = new File(root, AGENT_LOG_NAME);
            stdoutPump = startStreamPump(started.getInputStream(), logFile, "out");
            stderrPump = startStreamPump(started.getErrorStream(), logFile, "err");
            currentStatus = "running";
            updateNotification();
            Log.i(TAG, "Agent process started (pid=" + safePid(started) + ").");
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
            try (
                BufferedReader reader = new BufferedReader(new InputStreamReader(stream));
                FileOutputStream logOut = new FileOutputStream(logFile, true)
            ) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (Thread.currentThread().isInterrupted()) break;
                    String stamped = "[" + label + "] " + line + "\n";
                    logOut.write(stamped.getBytes());
                    if ("err".equals(label)) {
                        Log.w(TAG, line);
                    } else {
                        Log.i(TAG, line);
                    }
                }
            } catch (IOException error) {
                if (!shuttingDown) {
                    Log.w(TAG, "Stream pump (" + label + ") ended.", error);
                }
            }
        }, "MiladyAgent-pump-" + label);
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
        }, "MiladyAgent-restart").start();
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
            super("MiladyAgent-watchdog");
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

                if (probeHealth()) {
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
                } else {
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

        private boolean probeHealth() {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(HEALTH_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout((int) HEALTH_TIMEOUT_MS);
                conn.setReadTimeout((int) HEALTH_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                int status = conn.getResponseCode();
                return status >= 200 && status < 500;
            } catch (IOException error) {
                return false;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    // ── Notification helpers ─────────────────────────────────────────────

    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Milady Agent",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Local Milady agent runtime status");
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

        Intent stopIntent = new Intent(this, MiladyAgentService.class);
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
                title = "Milady agent · Running";
                text = "Local agent listening on :" + AGENT_PORT;
                break;
            case "starting":
                title = "Milady agent · Starting";
                text = "Preparing on-device runtime…";
                break;
            case "fatal":
                title = "Milady agent · Stopped";
                text = "Agent crashed repeatedly; tap to investigate";
                break;
            case "extract-failed":
                title = "Milady agent · Asset error";
                text = "Could not unpack runtime";
                break;
            case "missing-bundle":
            case "missing-bun":
            case "missing-loader":
                title = "Milady agent · Missing files";
                text = currentStatus;
                break;
            case "spawn-failed":
                title = "Milady agent · Spawn failed";
                text = "Could not start runtime process";
                break;
            default:
                title = "Milady agent";
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

    /** Start the foreground service (safe to call repeatedly). */
    public static void start(Context context) {
        Intent intent = new Intent(context, MiladyAgentService.class);
        intent.setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    /** Request a graceful stop via the ACTION_STOP intent. */
    public static void stop(Context context) {
        Intent intent = new Intent(context, MiladyAgentService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    /** Restart the agent process without tearing down the service. */
    public static void restart(Context context) {
        Intent intent = new Intent(context, MiladyAgentService.class);
        intent.setAction(ACTION_RESTART);
        context.startService(intent);
    }

    /** Push a status string into the foreground notification. */
    public static void updateStatus(Context context, String status) {
        Intent intent = new Intent(context, MiladyAgentService.class);
        intent.setAction(ACTION_UPDATE_STATUS);
        intent.putExtra(EXTRA_STATUS, status);
        context.startService(intent);
    }
}

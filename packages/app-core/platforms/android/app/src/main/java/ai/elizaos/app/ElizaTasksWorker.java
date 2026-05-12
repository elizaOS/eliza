package ai.elizaos.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * WorkManager worker that wakes the local Eliza agent runtime by POSTing to
 * {@code /api/internal/wake}. The handler runs {@code runDueTasks} so background
 * scheduled tasks (refresh fetches, notifications, retries) make progress even
 * while the app is suspended.
 *
 * <p>The contract matches {@code packages/app-core/src/api/internal-routes.ts}:
 * the runtime expects {@code POST /api/internal/wake} with body
 * {@code { kind: "refresh", deadlineMs: <absolute_ms> }} and a
 * {@code Authorization: Bearer <device_secret>} header.
 *
 * <p>Retry semantics:
 * <ul>
 *   <li>2xx → {@link Result#success()}</li>
 *   <li>5xx or network/IO error → {@link Result#retry()}</li>
 *   <li>401/4xx-permanent → {@link Result#failure()} (do not retry; misconfig)</li>
 * </ul>
 *
 * <p>The hard timeout is 25 seconds, just under the 30s deadline a typical
 * WorkManager constraint allows. The remote handler is given a deadline of
 * {@code now + 25s} so it returns before WorkManager kills us.
 */
public class ElizaTasksWorker extends Worker {

    private static final String TAG = "ElizaTasksWorker";

    // Mirrors Capacitor Preferences default group used by GatewayConnectionService.
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";

    // Capacitor Preferences keys consumed by the worker. The JS layer writes
    // these via @capacitor/preferences during onboarding / runtime bootstrap.
    private static final String KEY_DEVICE_SECRET = "eliza:device-secret";
    private static final String KEY_AGENT_BASE = "eliza:agent-base";

    private static final String DEFAULT_AGENT_BASE = "http://127.0.0.1:31337";
    private static final String WAKE_PATH = "/api/internal/wake";

    // Hard worker budget. The OS gives WorkManager more, but the wake handler
    // is designed to bail at deadlineMs and we want margin to flush the
    // response before returning.
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 25_000;
    private static final long DEADLINE_MS = 25_000L;

    public ElizaTasksWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(
            CAPACITOR_PREFS_GROUP,
            Context.MODE_PRIVATE
        );

        String deviceSecret = prefs.getString(KEY_DEVICE_SECRET, null);
        if (deviceSecret == null || deviceSecret.isEmpty()) {
            Log.w(TAG, "device secret not provisioned; skipping wake (permanent failure until JS writes it)");
            return Result.failure();
        }

        String agentBase = prefs.getString(KEY_AGENT_BASE, DEFAULT_AGENT_BASE);
        if (agentBase == null || agentBase.isEmpty()) {
            agentBase = DEFAULT_AGENT_BASE;
        }
        String endpoint = trimTrailingSlash(agentBase) + WAKE_PATH;

        long deadlineMs = System.currentTimeMillis() + DEADLINE_MS;
        String body;
        try {
            JSONObject json = new JSONObject();
            json.put("kind", "refresh");
            json.put("deadlineMs", deadlineMs);
            body = json.toString();
        } catch (JSONException e) {
            // JSONObject.put only throws on NaN/Infinity, which we don't pass.
            // Reaching here is a programming error, not a retryable failure.
            Log.e(TAG, "failed to serialize wake body", e);
            return Result.failure();
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceSecret);

            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }

            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) {
                Log.i(TAG, "wake delivered ok status=" + status);
                return Result.success();
            }
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || (status >= 400 && status < 500 && status != HttpURLConnection.HTTP_CLIENT_TIMEOUT)) {
                Log.w(TAG, "wake rejected with permanent status=" + status + "; not retrying");
                return Result.failure();
            }
            Log.w(TAG, "wake transient failure status=" + status + "; will retry");
            return Result.retry();
        } catch (IOException e) {
            Log.w(TAG, "wake network failure; will retry", e);
            return Result.retry();
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String trimTrailingSlash(String value) {
        if (value == null) return "";
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }
}

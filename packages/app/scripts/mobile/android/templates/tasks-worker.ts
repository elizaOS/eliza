/** Renders the Android tasks worker Java source for cloud-safe mobile builds. */

export function cloudSafeTasksWorkerJava(androidPackage) {
  return `package ${androidPackage};

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

public class ElizaTasksWorker extends Worker {

    private static final String TAG = "ElizaTasksWorker";
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";
    private static final String KEY_DEVICE_SECRET = "eliza:device-secret";
    private static final String KEY_AGENT_BASE = "eliza:agent-base";
    private static final String WAKE_PATH = "/api/internal/wake";
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
        String agentBase = prefs.getString(KEY_AGENT_BASE, null);
        if (deviceSecret == null || deviceSecret.isEmpty() || agentBase == null || agentBase.isEmpty()) {
            Log.w(TAG, "cloud wake credentials are not provisioned; skipping");
            return Result.failure();
        }

        String body;
        try {
            JSONObject json = new JSONObject();
            json.put("kind", "refresh");
            json.put("deadlineMs", System.currentTimeMillis() + DEADLINE_MS);
            body = json.toString();
        } catch (JSONException e) {
            Log.e(TAG, "failed to serialize wake body", e);
            return Result.failure();
        }

        String endpoint = trimTrailingSlash(agentBase) + WAKE_PATH;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(endpoint);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                Log.w(TAG, "cloud wake requires https agent base");
                return Result.failure();
            }
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
                Log.i(TAG, "cloud wake delivered ok status=" + status);
                return Result.success();
            }
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || (status >= 400 && status < 500 && status != HttpURLConnection.HTTP_CLIENT_TIMEOUT)) {
                Log.w(TAG, "cloud wake rejected with permanent status=" + status + "; not retrying");
                return Result.failure();
            }
            Log.w(TAG, "cloud wake transient failure status=" + status + "; will retry");
            return Result.retry();
        } catch (IOException e) {
            Log.w(TAG, "cloud wake network failure; will retry", e);
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
`;
}

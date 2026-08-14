package ai.elizaos.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.net.HttpURLConnection;

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
 * WorkManager constraint allows. The local handler is given a deadline of
 * {@code now + 25s} so it returns before WorkManager kills us.
 */
public class ElizaTasksWorker extends Worker {

    private static final String TAG = "ElizaTasksWorker";

    private static final String WAKE_PATH = "/api/internal/wake";

    // Hard worker budget. The OS gives WorkManager more, but the wake handler
    // is designed to bail at deadlineMs and we want margin to flush the
    // response before returning.
    private static final int READ_TIMEOUT_MS = 25_000;
    private static final long DEADLINE_MS = 25_000L;

    public ElizaTasksWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        ElizaWorkScheduler.Decision decision = ElizaWorkScheduler.readDecision(context);
        if (!decision.shouldSchedule) {
            // A stale invocation can race a mode/background change. Cancel the
            // unique periodic work and retain failure semantics: unavailable
            // credentials are not fabricated into a successful wake.
            ElizaWorkScheduler.reconcile(context);
            Log.w(TAG, "wake ownership invalid reason=" + decision.reason + "; periodic work cancelled");
            return Result.failure();
        }
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

        return deliverWakeViaAgentService(decision.deviceSecret, body);
    }

    private static Result deliverWakeViaAgentService(String deviceSecret, String body) {
        try {
            JSONObject headers = new JSONObject();
            headers.put("Content-Type", "application/json");
            headers.put("Authorization", "Bearer " + deviceSecret);
            JSONObject request = new JSONObject();
            request.put("method", "POST");
            request.put("path", WAKE_PATH);
            request.put("headers", headers);
            request.put("body", body);
            request.put("timeoutMs", READ_TIMEOUT_MS);

            JSONObject response = new JSONObject(ElizaAgentService.requestLocalAgent(request.toString()));
            int status = response.optInt("status", 0);
            if (status >= 200 && status < 300) {
                Log.i(TAG, "wake delivered via agent-service IPC status=" + status);
                return Result.success();
            }
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || (status >= 400 && status < 500 && status != HttpURLConnection.HTTP_CLIENT_TIMEOUT)) {
                Log.w(TAG, "wake rejected via agent-service IPC with permanent status=" + status + "; not retrying");
                return Result.failure();
            }
            Log.w(TAG, "wake transient agent-service IPC failure status=" + status + "; will retry");
            return Result.retry();
        } catch (Exception e) {
            Log.w(TAG, "wake agent-service IPC failure; will retry", e);
            return Result.retry();
        }
    }
}

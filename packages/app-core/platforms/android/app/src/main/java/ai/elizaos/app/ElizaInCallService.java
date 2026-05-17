package ai.elizaos.app;

import android.content.Intent;
import android.net.Uri;
import android.telecom.Call;
import android.telecom.InCallService;
import android.util.Log;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * In-call service.
 *
 * The InCallService is where Eliza actually owns the call lifecycle.
 * The framework drives onCallAdded → state changes → onCallRemoved; for
 * each call we register a per-call {@link Call.Callback}, mint a stable
 * call id (the framework's Call object identity is process-local and
 * not stable to forward to the WebView), and surface every state change
 * as a deep link into the Eliza WebView so the JS layer can render the
 * in-call UI and trigger answer/decline/mute/hold/dtmf back through
 * static helpers on this class.
 *
 * The actual answer/decline/etc. operations are exposed as static
 * methods so the JS layer can invoke them via the Capacitor bridge.
 * Each call is keyed by the id we minted at onCallAdded.
 */
public class ElizaInCallService extends InCallService {

    private static final String TAG = "ElizaInCallService";

    /** Process-wide registry of active calls keyed by stable id. */
    private static final Map<String, Call> ACTIVE_CALLS =
            Collections.synchronizedMap(new HashMap<>());

    /** Reverse mapping so onCallRemoved can find the id without iterating. */
    private static final Map<Call, String> CALL_IDS =
            Collections.synchronizedMap(new HashMap<>());

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        String callId = UUID.randomUUID().toString();
        ACTIVE_CALLS.put(callId, call);
        CALL_IDS.put(call, callId);
        call.registerCallback(new ElizaCallCallback(callId));
        Log.i(TAG, "Call added id=" + callId + " state=" + call.getState());
        openCallSurface("added", callId, call);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        String callId = CALL_IDS.remove(call);
        if (callId != null) {
            ACTIVE_CALLS.remove(callId);
        }
        Log.i(TAG, "Call removed id=" + callId);
        openCallSurface("removed", callId, call);
    }

    private void openCallSurface(String event, String callId, Call call) {
        Intent intent = new Intent(this, MainActivity.class);
        Call.Details details = call.getDetails();
        Uri handle = details != null ? details.getHandle() : null;
        String displayName = details != null ? details.getCallerDisplayName() : null;
        Uri.Builder route = Uri.parse("ai.elizaos.app://phone/call").buildUpon()
                .appendQueryParameter("event", event)
                .appendQueryParameter("state", String.valueOf(call.getState()));
        if (callId != null) {
            route.appendQueryParameter("callId", callId);
        }
        if (handle != null) {
            route.appendQueryParameter("uri", handle.toString());
            route.appendQueryParameter("number", handle.getSchemeSpecificPart());
        }
        if (displayName != null && !displayName.isEmpty()) {
            route.appendQueryParameter("name", displayName);
        }
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(route.build());
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }

    // ── Public API for the JS layer ───────────────────────────────────

    public static boolean answerCall(String callId, int videoState) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call == null) {
            Log.w(TAG, "answerCall: unknown id " + callId);
            return false;
        }
        call.answer(videoState);
        return true;
    }

    public static boolean rejectCall(String callId, boolean replyWithMessage, String message) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call == null) {
            Log.w(TAG, "rejectCall: unknown id " + callId);
            return false;
        }
        call.reject(replyWithMessage, message);
        return true;
    }

    public static boolean disconnectCall(String callId) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call == null) {
            Log.w(TAG, "disconnectCall: unknown id " + callId);
            return false;
        }
        call.disconnect();
        return true;
    }

    public static boolean holdCall(String callId, boolean hold) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call == null) {
            Log.w(TAG, "holdCall: unknown id " + callId);
            return false;
        }
        if (hold) {
            call.hold();
        } else {
            call.unhold();
        }
        return true;
    }

    public static boolean playDtmfTone(String callId, char digit) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call == null) {
            Log.w(TAG, "playDtmfTone: unknown id " + callId);
            return false;
        }
        call.playDtmfTone(digit);
        call.stopDtmfTone();
        return true;
    }

    /**
     * Per-call callback that bridges Call state changes to the WebView.
     * Without this the JS UI only sees onCallAdded/onCallRemoved and
     * misses ringing → active → on-hold → disconnected transitions.
     */
    private final class ElizaCallCallback extends Call.Callback {
        private final String callId;

        ElizaCallCallback(String callId) {
            this.callId = callId;
        }

        @Override
        public void onStateChanged(Call call, int state) {
            super.onStateChanged(call, state);
            openCallSurface("state-changed", callId, call);
        }

        @Override
        public void onDetailsChanged(Call call, Call.Details details) {
            super.onDetailsChanged(call, details);
            openCallSurface("details-changed", callId, call);
        }
    }
}

/**
 * Owns Telecom call lifecycles and the native call screen independently of WebView startup.
 * Per-call callbacks and notifications are removed with their call. Android owns ringing;
 * UI controls operate on the current Telecom Call, never on a reconstructed phone number.
 */
package ai.elizaos.app;

import android.content.Intent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.os.Build;
import android.telecom.CallAudioState;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Set;
import android.net.Uri;
import android.telecom.Call;
import android.telecom.InCallService;
import android.util.Log;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class ElizaInCallService extends InCallService {

    private static final String TAG = "ElizaInCallService";

    /** Process-wide registry of active calls keyed by stable id. */
    private static final Map<String, Call> ACTIVE_CALLS =
            Collections.synchronizedMap(new LinkedHashMap<>());

    /** Reverse mapping so onCallRemoved can find the id without iterating. */
    private static final Map<Call, String> CALL_IDS =
            Collections.synchronizedMap(new LinkedHashMap<>());

    private static final Set<Runnable> LISTENERS = new LinkedHashSet<>();
    private final Map<Call, Call.Callback> callbacks = new HashMap<>();
    private static ElizaInCallService activeService;
    private static final String CHANNEL = "eliza_phone_calls";

    @Override public void onCreate() {
        super.onCreate();
        activeService = this;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Phone calls", NotificationManager.IMPORTANCE_HIGH);
        // Telecom provides the ringtone; duplicate channel audio would ring twice.
        channel.setSound(null, null);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static List<String> callIds() { return new ArrayList<>(ACTIVE_CALLS.keySet()); }
    static Call call(String id) { return ACTIVE_CALLS.get(id); }
    static void observe(Runnable listener) { LISTENERS.add(listener); }
    static void unobserve(Runnable listener) { LISTENERS.remove(listener); }
    private static void publish() {
        for (Runnable listener : new ArrayList<>(LISTENERS)) listener.run();
    }
    static CallAudioState audioState() { return activeService == null ? null : activeService.getCallAudioState(); }
    static void mute(boolean muted) { if (activeService != null) activeService.setMuted(muted); }
    static void route(int route) { if (activeService != null) activeService.setAudioRoute(route); }

    @Override public void onCallAudioStateChanged(CallAudioState state) { publish(); }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        String callId = UUID.randomUUID().toString();
        ACTIVE_CALLS.put(callId, call);
        CALL_IDS.put(call, callId);
        Call.Callback callback = new ElizaCallCallback(callId);
        callbacks.put(call, callback);
        call.registerCallback(callback);
        Log.i(TAG, "Call added id=" + callId + " state=" + call.getState());
        openCallSurface("added", callId, call);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        Call.Callback callback = callbacks.remove(call);
        if (callback != null) call.unregisterCallback(callback);
        String callId = CALL_IDS.remove(call);
        if (callId != null) {
            ACTIVE_CALLS.remove(callId);
        }
        Log.i(TAG, "Call removed id=" + callId);
        openCallSurface("removed", callId, call);
    }

    private void openCallSurface(String event, String callId, Call call) {
        NotificationManager notifications = getSystemService(NotificationManager.class);
        if ("removed".equals(event) || call.getState() == Call.STATE_DISCONNECTED) {
            if (callId != null) notifications.cancel(callId, 1);
            publish();
            return;
        }
        Call.Details details = call.getDetails();
        Uri handle = details == null ? null : details.getHandle();
        String label = handle == null ? "Unknown caller" : handle.getSchemeSpecificPart();
        boolean ringing = call.getState() == Call.STATE_RINGING;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(label)
            .setContentText(ElizaInCallActivity.stateLabel(call.getState()))
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(callIntent(callId, "show"));
        if (ringing) builder.setFullScreenIntent(callIntent(callId, "show"), true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && ringing) {
            Person person = new Person.Builder().setName(label).setImportant(true).build();
            builder.setStyle(Notification.CallStyle.forIncomingCall(person,
                callIntent(callId, "reject"), callIntent(callId, "answer")));
        } else {
            // A Telecom-bound service is not an FGS. Ongoing CallStyle without
            // a full-screen intent is rejected by Android; use an ordinary
            // ongoing call notification rather than creating another service.
            if (ringing) builder.addAction(new Notification.Action.Builder(null, "Answer", callIntent(callId, "answer")).build());
            builder.addAction(new Notification.Action.Builder(null, ringing ? "Decline" : "End call", callIntent(callId, ringing ? "reject" : "disconnect")).build());
        }
        notifications.notify(callId, 1, builder.build());
        publish();
        // Open the call once, preserving the dialer's incoming/outgoing entry behavior.
        // Later state updates refresh the existing screen and notification without
        // taking focus back from another task on every Telecom callback.
        if ("added".equals(event)) showCall(callId);
    }

    private PendingIntent callIntent(String id, String command) {
        Intent intent = new Intent(this, ElizaInCallActivity.class)
            .setData(new Uri.Builder().scheme("eliza-call").authority(command).appendPath(id).build())
            .putExtra("callId", id).putExtra("command", command)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showCall(String id) {
        startActivity(new Intent(this, ElizaInCallActivity.class).putExtra("callId", id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
    }

    @Override public void onBringToForeground(boolean showDialpad) {
        List<String> ids = callIds();
        if (!ids.isEmpty()) showCall(ids.get(0));
    }

    @Override public void onDestroy() {
        NotificationManager notifications = getSystemService(NotificationManager.class);
        for (Map.Entry<Call, Call.Callback> entry : callbacks.entrySet()) entry.getKey().unregisterCallback(entry.getValue());
        for (String id : callIds()) notifications.cancel(id, 1);
        callbacks.clear();
        ACTIVE_CALLS.clear();
        CALL_IDS.clear();
        if (activeService == this) activeService = null;
        publish();
        super.onDestroy();
    }

    // These helpers return false when Telecom has already removed the call.

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
        return true;
    }

    public static void stopDtmfTone(String callId) {
        Call call = ACTIVE_CALLS.get(callId);
        if (call != null) call.stopDtmfTone();
    }

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

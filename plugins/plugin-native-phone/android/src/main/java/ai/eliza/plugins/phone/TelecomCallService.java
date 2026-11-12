/**
 * Owns Telecom call lifecycles and the native call screen independently of WebView or agent startup.
 * Per-call callbacks and notifications are removed with their call. Android owns ringing;
 * UI controls operate on the current Telecom Call, never on a reconstructed phone number. A host
 * holding the dialer role declares a subclass, protected by BIND_INCALL_SERVICE, and names its
 * call screen and notification channel in {@link #configuration()}. Telecom keeps emergency calls
 * working through the system dialer if this service fails.
 */
package ai.eliza.plugins.phone;

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
import android.telecom.PhoneAccount;
import android.util.Log;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public abstract class TelecomCallService extends InCallService {

    private static final String TAG = "TelecomCallService";

    /** Process-wide registry of active calls keyed by stable id. */
    private static final Map<String, Call> ACTIVE_CALLS =
            Collections.synchronizedMap(new LinkedHashMap<>());

    /** Reverse mapping so onCallRemoved can find the id without iterating. */
    private static final Map<Call, String> CALL_IDS =
            Collections.synchronizedMap(new LinkedHashMap<>());

    private static final Set<Runnable> LISTENERS = new LinkedHashSet<>();
    private final Map<Call, Call.Callback> callbacks = new HashMap<>();
    /** Contact names by call ID and number. An empty name is a lookup that found none or is running. Main thread only. */
    private final Map<String, String> names = new HashMap<>();
    private java.util.concurrent.ExecutorService lookups;
    private static TelecomCallService activeService;
    private TelecomCallConfiguration config;

    /** The host's call screen and notification identity. Read once when the service is created. */
    protected abstract TelecomCallConfiguration configuration();

    @Override public void onCreate() {
        super.onCreate();
        config = configuration();
        activeService = this;
        NotificationChannel channel = new NotificationChannel(config.channelId, config.channelName, NotificationManager.IMPORTANCE_HIGH);
        // Telecom provides the ringtone; duplicate channel audio would ring twice.
        channel.setSound(null, null);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    public static List<String> callIds() { return new ArrayList<>(ACTIVE_CALLS.keySet()); }
    public static Call call(String id) { return ACTIVE_CALLS.get(id); }
    public static void observe(Runnable listener) { LISTENERS.add(listener); }
    public static void unobserve(Runnable listener) { LISTENERS.remove(listener); }
    private static void publish() {
        for (Runnable listener : new ArrayList<>(LISTENERS)) listener.run();
    }
    public static CallAudioState audioState() { return activeService == null ? null : activeService.getCallAudioState(); }
    public static void mute(boolean muted) { if (activeService != null) activeService.setMuted(muted); }
    public static void route(int route) { if (activeService != null) activeService.setAudioRoute(route); }

    @Override public void onCallAudioStateChanged(CallAudioState state) { publish(); }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        String callId = UUID.randomUUID().toString();
        ACTIVE_CALLS.put(callId, call);
        CALL_IDS.put(call, callId);
        Call.Callback callback = new CallCallback(callId);
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
            names.keySet().removeIf(key -> key.startsWith(callId + '\n'));
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
        String label = callerLabel(callId, call.getDetails());
        boolean ringing = call.getState() == Call.STATE_RINGING;
        Notification.Builder builder = new Notification.Builder(this, config.channelId)
            .setSmallIcon(config.notificationIcon)
            .setContentTitle(label)
            .setContentText(TelecomCallActivity.stateLabel(call.getState()))
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

    /**
     * The caller's name for the notification: the name Telecom reports, else the owner's contact
     * for the number when this app may read contacts, else the number. The contact is read off the
     * main thread once per call; the notification shows the number until the name arrives.
     */
    private String callerLabel(String callId, Call.Details details) {
        Uri handle = details == null ? null : details.getHandle();
        String number = handle == null ? null : TelecomCallActivity.clean(handle.getSchemeSpecificPart());
        String name = details == null ? null : TelecomCallActivity.clean(details.getCallerDisplayName());
        if (name == null && details != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            name = TelecomCallActivity.clean(details.getContactDisplayName());
        }
        // A network that sends the number as the caller's name has named nobody.
        if (name != null && name.equals(number)) name = null;
        if (name == null && number != null && callId != null && PhoneAccount.SCHEME_TEL.equals(handle.getScheme())
                && checkSelfPermission(android.Manifest.permission.READ_CONTACTS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            String key = callId + '\n' + number;
            if (names.containsKey(key)) name = TelecomCallActivity.clean(names.get(key));
            else lookUp(key, callId, number);
        }
        return name != null ? name : number != null ? number : "Unknown caller";
    }

    private void lookUp(String key, String callId, String number) {
        names.put(key, "");
        if (lookups == null) lookups = java.util.concurrent.Executors.newSingleThreadExecutor();
        android.content.ContentResolver resolver = getApplicationContext().getContentResolver();
        android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        lookups.execute(() -> {
            String found = TelecomCallActivity.contactName(resolver, number);
            if (found == null) return;
            main.post(() -> {
                // A removed call or a destroyed service has dropped the key; it posts nothing.
                Call call = ACTIVE_CALLS.get(callId);
                if (activeService != this || call == null || !names.containsKey(key)
                        || checkSelfPermission(android.Manifest.permission.READ_CONTACTS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
                names.put(key, found);
                openCallSurface("named", callId, call);
            });
        });
    }

    private PendingIntent callIntent(String id, String command) {
        Intent intent = new Intent(this, config.callActivity)
            .setData(new Uri.Builder().scheme(config.callScheme).authority(command).appendPath(id).build())
            .putExtra("callId", id).putExtra("command", command)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showCall(String id) {
        startActivity(new Intent(this, config.callActivity).putExtra("callId", id)
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
        names.clear();
        if (lookups != null) lookups.shutdownNow();
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

    private final class CallCallback extends Call.Callback {
        private final String callId;

        CallCallback(String callId) {
            this.callId = callId;
        }

        @Override
        public void onStateChanged(Call call, int state) {
            super.onStateChanged(call, state);
            // Android can already have posted this callback when unregister runs.
            if (callbacks.get(call) != this || ACTIVE_CALLS.get(callId) != call) return;
            openCallSurface("state-changed", callId, call);
        }

        @Override
        public void onDetailsChanged(Call call, Call.Details details) {
            super.onDetailsChanged(call, details);
            if (callbacks.get(call) != this || ACTIVE_CALLS.get(callId) != call) return;
            openCallSurface("details-changed", callId, call);
        }
    }
}

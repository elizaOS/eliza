package ai.elizaos.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service for continuous-chat / VAD-gated voice capture
 * (R10 §6.2).
 *
 * Holds a microphone-typed foreground service so the OS doesn't kill the
 * TalkMode plugin's SpeechRecognizer / AudioRecord pipeline when the app
 * is backgrounded. The actual STT + audio playback path lives in the
 * TalkMode plugin (packages/native-plugins/talkmode/android/…) — this
 * service just provides the lifecycle anchor + persistent notification.
 *
 * On API 34+ the service MUST run with
 * {@link ServiceInfo#FOREGROUND_SERVICE_TYPE_MICROPHONE}, and the app
 * must declare the {@code FOREGROUND_SERVICE_MICROPHONE} permission
 * alongside {@code RECORD_AUDIO}. Both are declared in
 * AndroidManifest.xml.
 *
 * The TalkMode plugin's Kotlin side binds to this service when the
 * runtime flips into continuous-chat mode; when the user disables
 * continuous chat, the plugin calls {@link #stop(Context)}.
 */
public class ElizaVoiceCaptureService extends Service {

    private static final String TAG = "ElizaVoiceCapture";
    private static final String CHANNEL_ID = "eliza_voice_capture";
    private static final int NOTIFICATION_ID = 4;

    public static final String ACTION_START = "ai.elizaos.app.action.START_VOICE_CAPTURE";
    public static final String ACTION_STOP = "ai.elizaos.app.action.STOP_VOICE_CAPTURE";
    public static final String ACTION_SET_MODE = "ai.elizaos.app.action.SET_VOICE_MODE";
    public static final String EXTRA_MODE = "mode";

    /** Current declared mode (off / vad-gated / always-on). Reflected in
     *  the notification text so the user knows what the agent is doing. */
    private volatile String currentMode = "vad-gated";

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
        Notification notification = buildNotification();
        // R10 §6.2: foregroundServiceType must be "microphone" on API 34+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_SET_MODE.equals(action) && intent != null) {
            String mode = intent.getStringExtra(EXTRA_MODE);
            if (mode != null && !mode.isEmpty()) {
                currentMode = mode;
                Log.i(TAG, "Voice capture mode → " + mode);
                refreshNotification();
            }
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.cancel(NOTIFICATION_ID);
        }
        super.onDestroy();
    }

    // ── Notification ─────────────────────────────────────────────────────

    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Eliza Voice Capture",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Eliza listens for your voice in the background");
        channel.setShowBadge(false);
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) {
            mgr.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPending = PendingIntent.getActivity(
            this, 11, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, ElizaVoiceCaptureService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 12, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String title;
        String text;
        switch (currentMode) {
            case "always-on":
                title = "Eliza is listening";
                text = "Continuous chat is on. Tap to open the chat.";
                break;
            case "vad-gated":
                title = "Eliza is ready to listen";
                text = "Voice activation is on. The mic opens when you speak.";
                break;
            default:
                title = "Eliza voice capture";
                text = "Voice mode: " + currentMode;
                break;
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(launchPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Stop listening", stopPending)
            .build();
    }

    private void refreshNotification() {
        Notification notification = buildNotification();
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.notify(NOTIFICATION_ID, notification);
        }
    }

    // ── Static helpers ───────────────────────────────────────────────────

    /** Start the voice capture foreground service (safe to call repeatedly). */
    public static void start(Context context) {
        Intent intent = new Intent(context, ElizaVoiceCaptureService.class);
        intent.setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    /** Stop the voice capture foreground service. */
    public static void stop(Context context) {
        Intent intent = new Intent(context, ElizaVoiceCaptureService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    /**
     * Update the continuous-chat mode reflected in the notification.
     * Mode values: "off", "vad-gated", "always-on".
     */
    public static void setMode(Context context, String mode) {
        Intent intent = new Intent(context, ElizaVoiceCaptureService.class);
        intent.setAction(ACTION_SET_MODE);
        intent.putExtra(EXTRA_MODE, mode);
        context.startService(intent);
    }
}

package ai.elizaos.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import java.util.concurrent.CopyOnWriteArrayList;

/** Plays only the durable queue's current occurrence, without starting the agent. */
public final class ElizaAlarmRingingService extends Service {
    public static final String ACTION_RING = "ai.elizaos.app.alarm.RING";
    public static final String ACTION_STOP = "ai.elizaos.app.alarm.STOP";
    public static final String ACTION_SNOOZE = "ai.elizaos.app.alarm.SNOOZE";
    public static final String EXTRA_ID = "alarmId";
    public static final String EXTRA_GENERATION = "alarmGeneration";
    public static final int SNOOZE_MINUTES = 5;
    public static final long MAX_RING_MILLIS = 10 * 60 * 1000L;
    private static final String TAG = "ElizaAlarmRinging";
    private static final String CHANNEL = "eliza_owned_alarms";
    private static final int NOTIFICATION_ID = 52;
    private static final String ACTION_REFRESH = "ai.elizaos.app.alarm.REFRESH";
    private static volatile ElizaAlarmRingingService running;
    private static final CopyOnWriteArrayList<Runnable> observers = new CopyOnWriteArrayList<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AudioAttributes attributes = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();
    private ElizaAlarms.Occurrence current;
    private MediaPlayer player;
    private AudioFocusRequest focus;
    private PowerManager.WakeLock wakeLock;
    private long deadlineElapsed;
    private boolean foreground;
    private boolean prepared;
    private boolean focusHeld;
    private String notificationState;
    private final Runnable monitor = () -> {
        if (current != null && SystemClock.elapsedRealtime() >= deadlineElapsed) {
            ElizaAlarms.finish(this, current.id, current.generation, "timed_out");
        }
        refresh();
    };

    static void observe(Runnable observer) { observers.addIfAbsent(observer); }
    static void unobserve(Runnable observer) { observers.remove(observer); }
    private void publish() { for (Runnable observer : observers) observer.run(); }

    public static void start(Context context, ElizaAlarms.Occurrence occurrence) {
        if (occurrence == null) return;
        context.startForegroundService(command(context, ACTION_RING,
            occurrence.id, occurrence.generation));
    }

    /** A definition edit can retire its old sound, but cannot stop its successor. */
    public static void stopIfCurrent(Context context, String id, long generation) {
        ElizaAlarmRingingService service = running;
        if (service == null) return;
        service.handler.post(() -> {
            if (running == service && matches(service.current, id, generation)) service.refresh();
        });
    }

    /** Refresh after a committed queue edit; this performs no alarm operation. */
    public static void synchronize(Context context) {
        ElizaAlarmRingingService service = running;
        if (service != null) {
            service.handler.post(() -> { if (running == service) service.refresh(); });
            return;
        }
        ElizaAlarms.Occurrence active = ElizaAlarms.active(context);
        if (active != null) context.startForegroundService(command(context, ACTION_REFRESH,
            active.id, active.generation));
    }

    static Intent command(Context context, String action, String id, long generation) {
        return new Intent(context, ElizaAlarmRingingService.class)
            .setAction(action)
            .setData(identity(context, id, generation, action))
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_GENERATION, generation);
    }

    private static Uri identity(Context context, String id, long generation, String action) {
        return new Uri.Builder().scheme("eliza-alarm").authority(context.getPackageName())
            .appendPath(id).appendPath(Long.toString(generation)).appendPath(action).build();
    }

    public static void ensureNotificationChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Eliza alarms",
            NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Alarms created and managed in Eliza");
        // The service owns the looping alarm sound; the channel must not play it twice.
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    public static boolean notificationsEnabled(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return manager.areNotificationsEnabled() && (channel == null ||
            channel.getImportance() >= NotificationManager.IMPORTANCE_HIGH);
    }

    public static boolean canUseFullScreen(Context context) {
        if (!notificationsEnabled(context)) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 34) return manager.canUseFullScreenIntent();
        return Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(
            Manifest.permission.USE_FULL_SCREEN_INTENT) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean alarmSoundMuted(Context context) {
        AudioManager manager = context.getSystemService(AudioManager.class);
        return manager.isStreamMute(AudioManager.STREAM_ALARM) ||
            manager.getStreamVolume(AudioManager.STREAM_ALARM) == 0;
    }

    public static boolean defaultToneAvailable(Context context) {
        return RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM) != null;
    }

    @Override public void onCreate() {
        super.onCreate();
        running = this;
        ensureNotificationChannel(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            String id = intent.getStringExtra(EXTRA_ID);
            long generation = intent.getLongExtra(EXTRA_GENERATION, -1);
            // Generations are occurrence tokens, including after each snooze.
            if (id != null && ElizaAlarms.active(this, id, generation) != null) {
                if (ACTION_STOP.equals(action)) ElizaAlarms.dismiss(this, id, generation);
                else if (ACTION_SNOOZE.equals(action)) {
                    ElizaAlarms.snooze(this, id, generation, SNOOZE_MINUTES);
                }
            }
        }
        refresh();
        return current == null ? START_NOT_STICKY : START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static boolean matches(ElizaAlarms.Occurrence occurrence, String id, long generation) {
        return occurrence != null && occurrence.id.equals(id) && occurrence.generation == generation;
    }

    private void refresh() {
        handler.removeCallbacks(monitor);
        ElizaAlarms.Occurrence next = ElizaAlarms.active(this);
        if (next == null) {
            releaseSound();
            current = null;
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
            publish();
            stopSelf();
            return;
        }
        boolean changed = !matches(current, next.id, next.generation);
        if (changed) releaseSound();
        current = next;
        int queued = ElizaAlarms.queuedCount(this);
        boolean muted = alarmSoundMuted(this);
        boolean fullScreen = canUseFullScreen(this);
        String nextNotificationState = next.id + ":" + next.generation + ":" + queued + ":" + muted + ":" + fullScreen;
        Notification notification = notification(next, queued, muted, fullScreen);
        if (!foreground) {
            try {
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID,
                    notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                else startForeground(NOTIFICATION_ID, notification);
                foreground = true;
            } catch (RuntimeException error) {
                Log.e(TAG, "Alarm foreground playback denied", error);
                // No due instance can play through this denied foreground host. Preserve
                // their terminal failure, including queued instances, instead of stranding
                // them for a later foreground action to revive with a fresh sound budget.
                ElizaAlarms.retireBlockedDeliveries(this);
                current = null;
                // Each queued occurrence receives its own terminal failure if playback is denied.
                handler.post(this::refresh);
                return;
            }
        } else if (!nextNotificationState.equals(notificationState)) {
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification);
        }
        notificationState = nextNotificationState;
        if (changed) {
            long elapsedSinceStart = System.currentTimeMillis() - next.startedAt;
            // A backward wall-clock change cannot renew a restored occurrence's sound budget.
            long remaining = elapsedSinceStart < 0 ? 0 : MAX_RING_MILLIS - elapsedSinceStart;
            if (remaining <= 0) {
                finish(next, "timed_out");
                return;
            }
            deadlineElapsed = SystemClock.elapsedRealtime() + remaining;
            beginSound(next, remaining);
        }
        publish();
        if (current != null) handler.postDelayed(monitor,
            Math.max(0, deadlineElapsed - SystemClock.elapsedRealtime()));
    }

    private void beginSound(ElizaAlarms.Occurrence occurrence, long remaining) {
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":alarm");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(remaining);
        AudioManager audio = getSystemService(AudioManager.class);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes)
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(change -> {
                if (!matches(current, occurrence.id, occurrence.generation) || player == null) return;
                if (change == AudioManager.AUDIOFOCUS_GAIN) {
                    focusHeld = true;
                    if (prepared) {
                        try { player.start(); }
                        catch (IllegalStateException error) { finish(occurrence, "audio_error"); }
                    }
                } else if (change == AudioManager.AUDIOFOCUS_LOSS) {
                    focusHeld = false;
                    finish(occurrence, "audio_focus_denied");
                } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
                    change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                    focusHeld = false;
                    try { if (prepared && player.isPlaying()) player.pause(); }
                    catch (IllegalStateException error) { finish(occurrence, "audio_error"); }
                }
            }, handler).build();
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            finish(occurrence, "audio_focus_denied");
            return;
        }
        focusHeld = true;
        if (!defaultToneAvailable(this)) {
            finish(occurrence, "audio_error");
            return;
        }
        // Android resolves the symbolic settings URI to the current default at playback.
        Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        MediaPlayer candidate = new MediaPlayer();
        player = candidate;
        try {
            candidate.setAudioAttributes(attributes);
            candidate.setLooping(true);
            candidate.setDataSource(this, tone);
            candidate.setOnPreparedListener(prepared -> {
                if (player != prepared || !matches(current, occurrence.id, occurrence.generation)) return;
                if (SystemClock.elapsedRealtime() >= deadlineElapsed) {
                    finish(occurrence, "timed_out");
                    return;
                }
                if (ElizaAlarms.active(this, occurrence.id, occurrence.generation) == null) {
                    refresh();
                    return;
                }
                this.prepared = true;
                try { if (focusHeld) prepared.start(); }
                catch (IllegalStateException error) { finish(occurrence, "audio_error"); }
            });
            candidate.setOnErrorListener((failed, what, extra) -> {
                if (player == failed) finish(occurrence, "audio_error");
                return true;
            });
            candidate.prepareAsync();
        } catch (Exception error) {
            Log.e(TAG, "Default alarm tone could not play", error);
            finish(occurrence, "audio_error");
        }
    }

    private void finish(ElizaAlarms.Occurrence occurrence, String outcome) {
        if (!matches(current, occurrence.id, occurrence.generation)) return;
        ElizaAlarms.finish(this, occurrence.id, occurrence.generation, outcome);
        // Queue promotion happens before the next audible occurrence begins.
        handler.post(this::refresh);
    }

    private Notification notification(ElizaAlarms.Occurrence occurrence, int queued, boolean muted, boolean fullScreen) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, ElizaAlarmRingingActivity.class)
                .setData(identity(this, occurrence.id, occurrence.generation, "show"))
                .putExtra(EXTRA_ID, occurrence.id).putExtra(EXTRA_GENERATION, occurrence.generation)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text = muted ? "Alarm sound is muted in Android settings" :
            fullScreen ? "Stop or snooze this alarm" : "Tap to stop or snooze this alarm";
        if (queued > 0) text += " · " + queued + " more waiting";
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(occurrence.label.isEmpty() ? "Eliza alarm" : occurrence.label)
            .setContentText(text).setContentIntent(open).setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null, "Stop", actionPending(occurrence, ACTION_STOP)).build())
            .addAction(new Notification.Action.Builder(null, "Snooze 5 min", actionPending(occurrence, ACTION_SNOOZE)).build());
        if (fullScreen) builder.setFullScreenIntent(open, true);
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }

    private PendingIntent actionPending(ElizaAlarms.Occurrence occurrence, String action) {
        return PendingIntent.getForegroundService(this, 0,
            command(this, action, occurrence.id, occurrence.generation),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void releaseSound() {
        prepared = false;
        focusHeld = false;
        if (player != null) {
            player.setOnPreparedListener(null);
            player.setOnErrorListener(null);
            player.release();
            player = null;
        }
        if (focus != null) {
            getSystemService(AudioManager.class).abandonAudioFocusRequest(focus);
            focus = null;
        }
        if (wakeLock != null) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
        }
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        releaseSound();
        if (running == this) running = null;
        // Durable active state survives process/service loss and is bounded on restart.
        super.onDestroy();
    }
}

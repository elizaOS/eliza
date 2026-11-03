package ai.tokenjunction.valhalla;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

/**
 * Watches the PC agent while the phone is paired.
 * This is a normal foreground service. It does not ask Android to ignore battery optimization.
 */
public class CompanionService extends Service {
    static final String ACTION_UPDATE = "ai.tokenjunction.valhalla.UPDATE";
    private static final int ONGOING_ID = 41;
    private static final int ALERT_ID = 42;
    private static final String CHANNEL_WATCH = "valhalla-watch";
    private static final String CHANNEL_ALERT = "valhalla-alert";

    private HandlerThread thread;
    private Handler worker;
    private volatile boolean running;
    private int backoffStep;
    private String lastAlert = "";

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("valhalla-watch");
        thread.start();
        worker = new Handler(thread.getLooper());
        ensureChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notice = watchNotice("Watching the PC agent");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ONGOING_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ONGOING_ID, notice);
        }
        SessionStore store = new SessionStore(this);
        if (store.deskUrl().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker.post(this::loop);
        }
        return START_STICKY;
    }

    private void loop() {
        SessionStore store = new SessionStore(this);
        ErrorLog errors = new ErrorLog(this);
        DeskClient client = new DeskClient(store, errors);
        while (running) {
            if (store.token().isEmpty()) {
                DeskClient.Result paired = client.pair();
                if (!paired.ok) {
                    alert("offline", "PC agent is offline", paired.message);
                    publish("offline");
                    sleep(nextBackoff());
                    continue;
                }
            }
            DeskClient.Result beat = client.heartbeat();
            if (beat.tokenExpired) {
                publish("pair");
                sleep(nextBackoff());
                continue;
            }
            if (!beat.ok || beat.offline) {
                alert("offline", "PC agent is offline", beat.message);
                publish("offline");
                sleep(nextBackoff());
                continue;
            }
            backoffStep = 0;
            lastAlert = beat.stalled ? lastAlert : "";
            String status = beat.stalled ? "PC agent looks stalled" : beat.message;
            updateOngoing(status);
            if (beat.stalled) alert("stalled", "PC agent is stalled", "Open the app and tap Recover agent. Open positions are left alone.");
            publish(beat.stalled ? "stalled" : "ok");
            sleep(20_000);
        }
    }

    private int nextBackoff() {
        int[] steps = {1000, 2000, 4000, 8000, 16000, 30000};
        int wait = steps[Math.min(backoffStep, steps.length - 1)];
        if (backoffStep < steps.length - 1) backoffStep += 1;
        return wait;
    }

    private void publish(String kind) {
        Intent intent = new Intent(ACTION_UPDATE);
        intent.setPackage(getPackageName());
        intent.putExtra("kind", kind);
        sendBroadcast(intent);
    }

    private void alert(String key, String title, String text) {
        if (key.equals(lastAlert)) return;
        lastAlert = key;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification.Builder builder = note(CHANNEL_ALERT)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true);
        manager.notify(ALERT_ID, builder.build());
    }

    private void updateOngoing(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(ONGOING_ID, watchNotice(text));
    }

    private Notification watchNotice(String text) {
        return note(CHANNEL_WATCH)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Valhalla")
                .setContentText(text)
                .setOngoing(true)
                .build();
    }

    private Notification.Builder note(String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(this, channel);
        return new Notification.Builder(this);
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel watch = new NotificationChannel(CHANNEL_WATCH, "Desk watch", NotificationManager.IMPORTANCE_LOW);
        watch.setDescription("Shows that the phone is watching the PC agent. Battery optimization stays on.");
        NotificationChannel alert = new NotificationChannel(CHANNEL_ALERT, "Desk alerts", NotificationManager.IMPORTANCE_DEFAULT);
        alert.setDescription("Tells you when the PC agent is stalled or offline.");
        manager.createNotificationChannel(watch);
        manager.createNotificationChannel(alert);
    }

    private void sleep(int ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            running = false;
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (thread != null) {
            thread.interrupt();
            thread.quitSafely();
        }
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

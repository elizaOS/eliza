/**
 * Keeps an explicitly opted-in Light Phone III in full color while LightOS is
 * running. This direct-distribution-only foreground service observes the
 * SettingsProvider keys that the stock launcher rewrites and delegates all
 * repair decisions to {@link Lp3ColorPolicy}.
 */
package ai.elizaos.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;

public final class Lp3ColorPolicyService extends Service {
    static final String PREFERENCES_NAME = "lp3_color_policy";
    static final String OPT_IN_PREFERENCE = "enabled";
    private static final String TAG = "ElizaLp3Color";
    private static final String CHANNEL_ID = "lp3_color_policy";
    private static final int NOTIFICATION_ID = 31;
    private static final long REPAIR_DEBOUNCE_MILLIS = 150L;
    private static final String DALTONIZER_ENABLED =
        "accessibility_display_daltonizer_enabled";
    private static final String DALTONIZER_MODE = "accessibility_display_daltonizer";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ContentObserver settingsObserver;
    private Lp3ColorPolicy.Debouncer repairDebouncer;
    private boolean foregroundStarted;
    private boolean initialized;

    /**
     * Reconciles the private persistent opt-in with the service lifecycle. The
     * same-UID commands are the explicit activation path; boot delivery uses
     * the same device, permission, and preference gates.
     */
    static void sync(Context context, String trigger) {
        Context appContext = context.getApplicationContext();
        Lp3ColorPolicy.Decision decision;
        try {
            decision = currentDecision(appContext);
        } catch (RuntimeException error) {
            // error-policy:J1 Android receiver boundary — SettingsProvider or
            // package-state failures must be visible and must not start a guard
            // whose eligibility could not be established.
            Log.e(TAG, "[Lp3ColorPolicy] eligibility read failed; trigger=" + trigger, error);
            appContext.stopService(new Intent(appContext, Lp3ColorPolicyService.class));
            return;
        }

        if (decision != Lp3ColorPolicy.Decision.ELIGIBLE) {
            logInactiveDecision(trigger, decision);
            appContext.stopService(new Intent(appContext, Lp3ColorPolicyService.class));
            return;
        }

        Intent serviceIntent = new Intent(appContext, Lp3ColorPolicyService.class);
        try {
            appContext.startForegroundService(serviceIntent);
            Log.i(TAG, "[Lp3ColorPolicy] foreground guard requested; trigger=" + trigger);
        } catch (IllegalStateException | SecurityException error) {
            // error-policy:J1 Android receiver boundary — background FGS
            // denial is an observable durability failure, never a silent boot
            // success. specialUse is legal from BOOT_COMPLETED, but OEM policy
            // may still deny the start.
            Log.e(TAG, "[Lp3ColorPolicy] foreground guard start failed; trigger=" + trigger, error);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Lp3ColorPolicy.Decision decision;
        try {
            decision = currentDecision(this);
        } catch (RuntimeException error) {
            // error-policy:J1 Android service boundary — a service whose
            // eligibility cannot be established must stop before foreground
            // or observer setup.
            Log.e(TAG, "[Lp3ColorPolicy] service eligibility read failed", error);
            stopAndRemoveNotification();
            return;
        }
        if (decision != Lp3ColorPolicy.Decision.ELIGIBLE) {
            logInactiveDecision("service-create", decision);
            stopAndRemoveNotification();
            return;
        }

        try {
            ensureNotificationChannel();
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            foregroundStarted = true;
            registerSettingsObserver();
            initialized = reconcileAtBoundary("service-create");
        } catch (RuntimeException error) {
            // error-policy:J1 Android service boundary — notification/FGS or
            // SettingsProvider failures make persistence unavailable, so stop
            // instead of leaving a misleading ongoing notification.
            Log.e(TAG, "[Lp3ColorPolicy] service initialization failed", error);
            stopAndRemoveNotification();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!initialized) {
            Log.e(TAG, "[Lp3ColorPolicy] refusing sticky restart before successful initialization");
            stopAndRemoveNotification();
            return START_NOT_STICKY;
        }
        Lp3ColorPolicy.Decision decision;
        try {
            decision = currentDecision(this);
        } catch (RuntimeException error) {
            // error-policy:J1 Android sticky-restart boundary — a restored
            // process must re-establish every gate before it can remain alive.
            Log.e(TAG, "[Lp3ColorPolicy] service restart eligibility read failed", error);
            stopAndRemoveNotification();
            return START_NOT_STICKY;
        }
        if (!Lp3ColorPolicy.shouldKeepStickyRestart(initialized, decision)) {
            logInactiveDecision("service-start", decision);
            stopAndRemoveNotification();
            return START_NOT_STICKY;
        }
        if (repairDebouncer != null) repairDebouncer.request();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        initialized = false;
        if (repairDebouncer != null) {
            repairDebouncer.cancel();
            repairDebouncer = null;
        }
        if (settingsObserver != null) {
            getContentResolver().unregisterContentObserver(settingsObserver);
            settingsObserver = null;
        }
        if (foregroundStarted) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void registerSettingsObserver() {
        ContentResolver resolver = getContentResolver();
        repairDebouncer = new Lp3ColorPolicy.Debouncer(
            new Lp3ColorPolicy.Scheduler() {
                @Override
                public void remove(Runnable task) {
                    handler.removeCallbacks(task);
                }

                @Override
                public void postDelayed(Runnable task, long delayMillis) {
                    handler.postDelayed(task, delayMillis);
                }
            },
            () -> reconcileAtBoundary("settings-change"),
            REPAIR_DEBOUNCE_MILLIS
        );
        settingsObserver = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange) {
                Lp3ColorPolicy.Debouncer debouncer = repairDebouncer;
                if (debouncer != null) debouncer.request();
            }
        };
        resolver.registerContentObserver(
            Settings.Secure.getUriFor(DALTONIZER_ENABLED),
            false,
            settingsObserver
        );
        resolver.registerContentObserver(
            Settings.Secure.getUriFor(DALTONIZER_MODE),
            false,
            settingsObserver
        );
    }

    private boolean reconcileAtBoundary(String trigger) {
        try {
            Lp3ColorPolicy.Outcome outcome = Lp3ColorPolicy.reconcile(new AndroidState(this));
            if (outcome == Lp3ColorPolicy.Outcome.REPAIRED) {
                Log.i(TAG, "[Lp3ColorPolicy] restored full color; trigger=" + trigger);
                return true;
            }
            if (outcome == Lp3ColorPolicy.Outcome.ALREADY_CORRECT) {
                Log.d(TAG, "[Lp3ColorPolicy] color state already correct; trigger=" + trigger);
                return true;
            }
            logInactiveDecision(trigger, Lp3ColorPolicy.Decision.valueOf(outcome.name()));
            stopAndRemoveNotification();
            return false;
        } catch (RuntimeException error) {
            // error-policy:J1 ContentObserver/service boundary — a rejected
            // secure-setting write is terminal for this service instance and
            // is surfaced in logcat for the operator.
            Log.e(TAG, "[Lp3ColorPolicy] color repair failed; trigger=" + trigger, error);
            stopAndRemoveNotification();
            return false;
        }
    }

    private void stopAndRemoveNotification() {
        initialized = false;
        if (repairDebouncer != null) {
            repairDebouncer.cancel();
            repairDebouncer = null;
        }
        if (settingsObserver != null) {
            getContentResolver().unregisterContentObserver(settingsObserver);
            settingsObserver = null;
        }
        if (foregroundStarted) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foregroundStarted = false;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
        stopSelf();
    }

    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "LP3 color guard",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps an explicitly opted-in Light Phone III in full color");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            throw new IllegalStateException("NotificationManager unavailable");
        }
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            31,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Eliza display color")
            .setContentText("Keeping this Light Phone III in full color")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private static Lp3ColorPolicy.Decision currentDecision(Context context) {
        AndroidState state = new AndroidState(context);
        return Lp3ColorPolicy.decide(
            state.buildEnabled(),
            state.manufacturer(),
            state.model(),
            state.optedIn(),
            state.hasWriteSecureSettings()
        );
    }

    static boolean isOptedIn(Context context) {
        return preferences(context).getBoolean(OPT_IN_PREFERENCE, false);
    }

    static void setOptedIn(Context context, boolean enabled) {
        Lp3ColorPolicy.persistOptIn(
            value -> preferences(context).edit().putBoolean(OPT_IN_PREFERENCE, value).commit(),
            enabled
        );
    }

    private static SharedPreferences preferences(Context context) {
        Context storageContext = context.createDeviceProtectedStorageContext();
        return storageContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private static void logInactiveDecision(String trigger, Lp3ColorPolicy.Decision decision) {
        String message = "[Lp3ColorPolicy] guard inactive; trigger=" + trigger + "; reason=" + decision;
        if (decision == Lp3ColorPolicy.Decision.MISSING_PERMISSION) {
            Log.e(TAG, message + "; grant android.permission.WRITE_SECURE_SETTINGS");
        } else {
            Log.i(TAG, message);
        }
    }

    private static final class AndroidState implements Lp3ColorPolicy.State {
        private final Context context;
        private final ContentResolver resolver;

        AndroidState(Context context) {
            this.context = context;
            this.resolver = context.getContentResolver();
        }

        @Override
        public boolean buildEnabled() {
            return BuildConfig.ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED;
        }

        @Override
        public String manufacturer() {
            return Build.MANUFACTURER;
        }

        @Override
        public String model() {
            return Build.MODEL;
        }

        @Override
        public boolean optedIn() {
            return isOptedIn(context);
        }

        @Override
        public boolean hasWriteSecureSettings() {
            return context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED;
        }

        @Override
        public int colorCorrectionEnabled() {
            return Settings.Secure.getInt(
                resolver,
                DALTONIZER_ENABLED,
                Lp3ColorPolicy.COLOR_CORRECTION_DISABLED
            );
        }

        @Override
        public int colorCorrectionMode() {
            return Settings.Secure.getInt(
                resolver,
                DALTONIZER_MODE,
                Lp3ColorPolicy.COLOR_CORRECTION_MODE_DISABLED
            );
        }

        @Override
        public boolean writeColorCorrectionEnabled(int value) {
            return Settings.Secure.putInt(resolver, DALTONIZER_ENABLED, value);
        }

        @Override
        public boolean writeColorCorrectionMode(int value) {
            return Settings.Secure.putInt(resolver, DALTONIZER_MODE, value);
        }
    }
}

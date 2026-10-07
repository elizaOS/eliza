package ai.elizaos.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/** An app-owned notification connection for Android systems without GMS.
 * The service owns native transport and survives WebView destruction. It does
 * not run an agent or create/read/complete reminders on the server. First
 * online activation requires a successful full baseline; earlier inbox
 * history is not promised as new background delivery. Subsequent offline
 * arrivals recover through the same durable receipt journal. */
public final class NativeNotificationConnectionService extends Service {
    private static final String PREFS = "eliza_native_notification_connection";
    private static final String CHANNEL = "eliza_native_connection";
    private static final int NOTICE = 17042;
    private static final String STOP = "ai.elizaos.app.NATIVE_NOTIFICATIONS_STOP";
    private static final int MAX_BODY = 4 * 1024 * 1024;
    private static final Object CONTROL = new Object();
    private static volatile String state = "stopped";
    private static volatile String activeOwner;
    private static volatile JSONObject inboxStatus;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();
    private NativeNotificationAuthority authority;
    private NativeNotificationInbox inbox;
    private volatile WebSocket socket;
    private volatile Call hydration;
    private volatile boolean stopped;
    private boolean reconnectPending;
    private volatile long connection;
    private int failures;
    private java.util.concurrent.ScheduledFuture<?> reconnect;
    private final java.util.concurrent.atomic.AtomicInteger outstandingFrames = new java.util.concurrent.atomic.AtomicInteger();
    private final java.util.concurrent.atomic.AtomicBoolean overloaded = new java.util.concurrent.atomic.AtomicBoolean();

    static boolean requiresNative(Context context) {
        try {
            return !context.getPackageManager().getApplicationInfo("com.google.android.gms", 0).enabled;
        } catch (PackageManager.NameNotFoundException missing) {
            return true;
        }
    }

    static boolean exempt(Context context) {
        PowerManager power = context.getSystemService(PowerManager.class);
        return Build.VERSION.SDK_INT < 23 || (power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
    }

    static JSONObject status(Context context) throws Exception {
        boolean selected = requiresNative(context);
        boolean current = false;
        String profileOwner = null;
        if (selected) {
            try {
                NativeNotificationAuthority owner = new NativeNotificationAuthority(context);
                profileOwner = owner.owner;
                current = owner.owner.equals(activeOwner);
            } catch (Exception unavailable) {
                // A missing/revoked owner is explicitly unavailable, never an
                // empty successful notification session.
            }
        }
        boolean allowed = NotificationManagerCompat.from(context).areNotificationsEnabled();
        boolean activated = current && inboxStatus != null && inboxStatus.optBoolean("initialized", false);
        boolean enabled = NativeNotificationState.enabled(state,
            context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false), current, allowed, activated);
        return new JSONObject().put("transport", selected ? "native" : "fcm")
            .put("owner", profileOwner == null ? JSONObject.NULL : profileOwner)
            .put("activated", activated)
            .put("enabled", enabled)
            .put("connected", current && "connected".equals(state))
            .put("state", current ? state : "unavailable")
            .put("batteryExempt", exempt(context))
            .put("notificationsAllowed", allowed)
            .put("backgroundReliable", enabled && "connected".equals(state) && exempt(context))
            .put("inbox", current && inboxStatus != null ? inboxStatus : JSONObject.NULL);
    }

    /** Foreground and background arrivals share the same native receipt file.
     * Before first online activation they are durably buffered, not reported as
     * OS presentation. A reconnect snapshot cannot alert them a second time. */
    static JSONObject present(Context context, String expectedOwner, String expectedBase, JSONObject notification) throws Exception {
        if (!requiresNative(context)) throw new SecurityException("Native notification fallback unavailable");
        NativeNotificationAuthority owner = new NativeNotificationAuthority(context);
        String expected = ClockHostPolicy.base(expectedBase).toString().replaceAll("/+$", "");
        if (!owner.owner.equals(expectedOwner) || !owner.base.toString().replaceAll("/+$", "").equals(expected))
            throw new SecurityException("Native notification foreground owner changed");
        // Retention is not authorization: first-activation buffering must also
        // reject a stopped/revoked selection. Release this gate before taking
        // the inbox lock; the post callback uses Inbox -> CONTROL -> store.
        synchronized (CONTROL) {
            owner.current();
            if (!context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)
                || !owner.owner.equals(context.getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", ""))
                || "authorization_rejected".equals(state))
                throw new SecurityException("Native notification foreground retention unavailable");
        }
        NativeNotificationInbox shared = new NativeNotificationInbox(context.getNoBackupFilesDir().getCanonicalFile().toPath(), owner.owner,
            record -> {
                synchronized (CONTROL) {
                    return owner.store.withSnapshot(owner.snapshot, () -> {
                        if (!context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)
                            || !owner.owner.equals(context.getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", ""))
                            || "authorization_rejected".equals(state))
                            throw new SecurityException("Native notification foreground delivery unavailable");
                        owner.current();
                        boolean accepted = NativeNotificationProjector.post(context, owner.owner, record);
                        try { owner.current(); }
                        catch (Exception changed) { retireOwner(context, owner.owner); throw changed; }
                        return accepted;
                    });
                }
            }, NativeNotificationProjector::syncDirectory);
        JSONObject result = shared.acceptLive(notification);
        if (owner.owner.equals(activeOwner)) inboxStatus = shared.status();
        return result;
    }

    static void start(Context context) throws Exception {
        if (!requiresNative(context)) return;
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()
            || (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED))
            throw new SecurityException("Allow Eliza notifications before enabling background delivery");
        NativeNotificationAuthority owner = new NativeNotificationAuthority(context);
        owner.current();
        synchronized (CONTROL) {
            if (!context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean("enabled", true).putString("owner", owner.owner).commit())
                throw new IllegalStateException("Native notification selection could not be saved");
        }
        Intent intent = new Intent(context, NativeNotificationConnectionService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    static void stop(Context context) {
        try { synchronized (CONTROL) {
            state = "stopped";
            if (!context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).commit())
                throw new IllegalStateException("Native notification stop could not be saved");
            state = "stopped";
            retireOwner(context, activeOwner);
        } } finally { context.stopService(new Intent(context, NativeNotificationConnectionService.class)); }
    }

    /** Resume only the already enabled, identical authenticated profile. */
    static void resume(Context context) {
        if (!requiresNative(context) || !context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)) return;
        try {
            NativeNotificationAuthority owner = new NativeNotificationAuthority(context);
            if (!owner.owner.equals(context.getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", ""))) return;
            Intent intent = new Intent(context, NativeNotificationConnectionService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception denied) {
            state = "resume_unavailable";
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Eliza connection", NotificationManager.IMPORTANCE_LOW));
        try {
            if (Build.VERSION.SDK_INT >= 34)
                startForeground(NOTICE, notice("Connecting to your agent"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(NOTICE, notice("Connecting to your agent"));
        } catch (RuntimeException denied) {
            state = "start_denied";
            stopped = true;
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (stopped) return START_NOT_STICKY;
        if (intent != null && STOP.equals(intent.getAction())) {
            try { stop(this); }
            catch (RuntimeException unavailable) { state = "retirement_unavailable"; }
            stopSelf();
            return START_NOT_STICKY;
        }
        worker.execute(() -> {
            try {
            String selected = getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", "");
            if (authority != null && !selected.equals(authority.owner)) {
                retireOwner(this, authority.owner);
                ++connection;
                if (reconnect != null) reconnect.cancel(false);
                if (socket != null) socket.cancel();
                socket = null;
                if (hydration != null) hydration.cancel();
                inbox = null;
                inboxStatus = null;
                reconnectPending = false;
            }
            if (socket == null && !reconnectPending) connect();
            else updateNotice();
            } catch (RuntimeException unavailable) { state = "startup_unavailable"; stopSelf(); }
        });
        return START_STICKY;
    }

    private void connect() {
        if (socket != null || stopped) return;
        reconnectPending = false;
        overloaded.set(false);
        final long attempt = ++connection;
        try {
            if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false) || !requiresNative(this)) {
                stopSelf(); return;
            }
            NativeNotificationAuthority next = new NativeNotificationAuthority(this);
            if (!next.owner.equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", ""))) {
                retireOwner(this, activeOwner);
                state = "owner_changed"; stopSelf(); return;
            }
            authority = next;
            activeOwner = next.owner;
            if (inbox == null) inbox = new NativeNotificationInbox(getNoBackupFilesDir().getCanonicalFile().toPath(), next.owner,
                notification -> {
                    NativeNotificationAuthority current = authority;
                    synchronized (CONTROL) {
                        return current.store.withSnapshot(current.snapshot, () -> {
                            requireCurrent(connection, current);
                            boolean accepted = NativeNotificationProjector.post(this, current.owner, notification);
                            try { current.current(); }
                            catch (Exception changed) { retireOwner(this, current.owner); throw changed; }
                            return accepted;
                        });
                    }
                }, NativeNotificationProjector::syncDirectory);
            inbox.beginBaseline();
            inboxStatus = inbox.status();
            state = "connecting";
            updateNotice();
            socket = http.newWebSocket(next.request("/ws"), new WebSocketListener() {
                @Override public void onOpen(WebSocket opened, Response response) {
                    dispatch(attempt, () -> {
                        requireCurrent(attempt, next);
                        hydrate(attempt, next);
                    });
                }
                @Override public void onMessage(WebSocket opened, String text) {
                    if (outstandingFrames.incrementAndGet() > 128) {
                        outstandingFrames.decrementAndGet();
                        if (overloaded.compareAndSet(false, true)) dispatch(attempt, () -> fail(attempt, "event_backlog"));
                        return;
                    }
                    dispatch(attempt, () -> {
                        try {
                            requireCurrent(attempt, next);
                            JSONObject notification;
                            try {
                                notification = NativeNotificationWire.notification(text);
                            } catch (org.json.JSONException | IllegalArgumentException invalidFrame) {
                                // Reject only this untrusted event. Authentication,
                                // journal and platform failures still fail the connection.
                                android.util.Log.w("ElizaNotifications", "Ignored invalid notification frame");
                                return;
                            }
                            if (notification == null) return;
                            inbox.acceptLive(notification);
                            inboxStatus = inbox.status();
                        } finally { outstandingFrames.decrementAndGet(); }
                    });
                }
                @Override public void onFailure(WebSocket opened, Throwable error, Response response) {
                    dispatch(attempt, () -> {
                        if (response != null && (response.code() == 401 || response.code() == 403)) revoke(attempt);
                        else fail(attempt, "disconnected");
                    });
                }
                @Override public void onClosed(WebSocket opened, int code, String reason) {
                    dispatch(attempt, () -> fail(attempt, "disconnected"));
                }
            });
            worker.schedule(() -> verifyOwner(attempt, next), 20, TimeUnit.SECONDS);
        } catch (Exception unavailable) {
            retireOwner(this, activeOwner);
            state = "unavailable";
            stopSelf();
        }
    }

    private void hydrate(long attempt, NativeNotificationAuthority owner) throws Exception {
        Call request = http.newCall(owner.request("/api/notifications"));
        hydration = request;
        request.enqueue(new Callback() {
            @Override public void onFailure(Call call, java.io.IOException error) {
                dispatch(attempt, () -> fail(attempt, "inbox_unavailable"));
            }
            @Override public void onResponse(Call call, Response response) {
                try (Response received = response) {
                    requireCurrent(attempt, owner);
                    if (received.code() == 401 || received.code() == 403) {
                        dispatch(attempt, () -> revoke(attempt)); return;
                    }
                    if (!received.isSuccessful()) throw new IllegalStateException("Native notification inbox unavailable");
                    ResponseBody body = received.body();
                    if (body == null || body.contentLength() > MAX_BODY) throw new IllegalStateException("Native notification response too large");
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream input = body.byteStream()) {
                        byte[] buffer = new byte[8192]; int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (bytes.size() + count > MAX_BODY) throw new IllegalStateException("Native notification response too large");
                            bytes.write(buffer, 0, count);
                        }
                    }
                    requireCurrent(attempt, owner);
                    JSONObject result = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
                    if (!"ready".equals(result.optString("serviceStatus"))) throw new IllegalStateException("Native notification service is not ready");
                    JSONArray records = result.getJSONArray("notifications");
                    // HTTP reads never block the serial event queue. Live
                    // new-notification frames are buffered by the inbox while
                    // this complete baseline is in flight.
                    dispatch(attempt, () -> {
                        requireCurrent(attempt, owner);
                        inbox.completeBaseline(records);
                        inboxStatus = inbox.status();
                        failures = 0;
                        state = "connected";
                        updateNotice();
                        if (hydration == call) hydration = null;
                    });
                } catch (Exception unavailable) {
                    dispatch(attempt, () -> fail(attempt, "inbox_unavailable"));
                }
            }
        });
    }

    private void requireCurrent(long attempt, NativeNotificationAuthority owner) throws Exception {
        if (stopped || attempt != connection || "stopped".equals(state) || "authorization_rejected".equals(state)
            || "start_denied".equals(state) || "retirement_unavailable".equals(state))
            throw new SecurityException("Native notification connection retired");
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)
            || !owner.owner.equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString("owner", "")))
            throw new SecurityException("Native notification selection changed");
        owner.current();
    }

    private void verifyOwner(long attempt, NativeNotificationAuthority owner) {
        if (stopped || attempt != connection) return;
        try {
            owner.current();
            worker.schedule(() -> verifyOwner(attempt, owner), 20, TimeUnit.SECONDS);
        } catch (Exception changed) {
            // A Clock/device slot update can change the store generation while
            // retaining this exact profile. Retire this socket before taking a
            // new snapshot; a different credential fingerprint never resumes.
            String reason = "owner_changed";
            try {
                NativeNotificationAuthority refreshed = new NativeNotificationAuthority(this);
                if (owner.owner.equals(refreshed.owner)) reason = "snapshot_changed";
            } catch (Exception unavailable) {
                // A missing current profile is a retired authority.
            }
            fail(attempt, reason);
        }
    }

    private void revoke(long attempt) {
        if (attempt != connection || stopped) return;
        synchronized (CONTROL) {
            if (!getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).commit())
                throw new IllegalStateException("Native notification revocation could not be saved");
            retireOwner(this, activeOwner);
        }
        state = "authorization_rejected";
        stopSelf();
    }

    private void fail(long attempt, String reason) {
        if (stopped || attempt != connection || reconnectPending) return;
        ++connection;
        if (socket != null) socket.cancel();
        socket = null;
        if (hydration != null) hydration.cancel();
        state = reason;
        if ("owner_changed".equals(reason)) retireOwner(this, activeOwner);
        updateNotice();
        reconnectPending = true;
        long ceiling = Math.min(60_000L, 1000L << Math.min(failures++, 6));
        long delay = ceiling / 2 + java.util.concurrent.ThreadLocalRandom.current().nextLong(Math.max(1, ceiling / 2));
        final long retired = connection;
        reconnect = worker.schedule(() -> {
            if (!stopped && retired == connection && socket == null) connect();
        }, delay, TimeUnit.MILLISECONDS);
    }

    private interface Work { void run() throws Exception; }
    private void dispatch(long attempt, Work work) {
        if (worker.isShutdown()) return;
        try {
            worker.execute(() -> {
                try { work.run(); }
                catch (Exception failure) { fail(attempt, "delivery_unavailable"); }
            });
        } catch (java.util.concurrent.RejectedExecutionException retired) { }
    }

    private static void retireOwner(Context context, String owner) {
        if (owner == null || owner.isEmpty()) return;
        try { NativeNotificationProjector.retireOwner(context, owner); }
        catch (java.io.IOException unavailable) {
            state = "retirement_unavailable";
            throw new IllegalStateException("Native notification retirement unavailable", unavailable);
        }
    }

    private android.app.Notification notice(String text) {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = PendingIntent.getActivity(this, NOTICE, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, NOTICE,
            new Intent(this, NativeNotificationConnectionService.class).setAction(STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Eliza notifications").setContentText(text).setContentIntent(tap)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .addAction(0, "Stop connection", stop).build();
    }

    private void updateNotice() {
        String text = "connected".equals(state) ? "Connected to your agent" : "Reconnecting to your agent";
        if (inboxStatus == null || !inboxStatus.optBoolean("initialized", false)) text = "Connect once to enable notifications";
        if (!exempt(this)) text = "Allow background activity in Permissions";
        getSystemService(NotificationManager.class).notify(NOTICE, notice(text));
    }

    @Override public void onDestroy() {
        stopped = true;
        ++connection;
        if (socket != null) socket.cancel();
        if (hydration != null) hydration.cancel();
        if (reconnect != null) reconnect.cancel(false);
        worker.shutdownNow();
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
        activeOwner = null;
        inboxStatus = null;
        if (!"authorization_rejected".equals(state) && !"owner_changed".equals(state)) state = "stopped";
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

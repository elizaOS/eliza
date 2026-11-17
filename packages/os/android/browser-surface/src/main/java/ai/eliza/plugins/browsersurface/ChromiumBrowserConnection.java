package ai.eliza.plugins.browsersurface;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Build;
import android.os.Looper;
import android.util.Log;
import java.util.function.Consumer;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsServiceConnection;

/**
 * Keeps the authorized native browser reachable while its agent runs as a foreground service:
 * always after {@link #start()}, or only while a {@link Lease} is open and for an idle delay after.
 * The hold, retry, release and ready rules are {@link ChromiumBindingDemand}'s, which runs only on
 * the main thread: a call from another thread is posted there in call order, and ready callbacks
 * are always posted to the main thread, never run inside the caller's call.
 */
public final class ChromiumBrowserConnection implements AutoCloseable {
    private static final String TAG = "ElizaChromiumBinding";
    private static final String BROWSER = BuildConfig.ELIZA_CHROMIUM_PACKAGE_NAME;
    /** How long the binding outlives its last holder when the host gives no delay. */
    public static final long DEFAULT_IDLE_RELEASE_MILLIS = 60000;
    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ChromiumBindingDemand demand;

    public ChromiumBrowserConnection(Context foregroundService) {
        this(foregroundService, DEFAULT_IDLE_RELEASE_MILLIS);
    }

    public ChromiumBrowserConnection(Context foregroundService, long idleReleaseMillis) {
        context = foregroundService;
        demand = new ChromiumBindingDemand(idleReleaseMillis, new ChromiumBindingDemand.Host() {
            @Override public ChromiumBindingDemand.BindResult bind() { return bindService(); }

            @Override public void unbind() {
                context.unbindService(connection);
                Log.i(TAG, "Chromium binding released");
            }

            @Override public void schedule(Runnable task, long delayMillis) {
                handler.postDelayed(task, delayMillis);
            }

            @Override public void cancel(Runnable task) { handler.removeCallbacks(task); }
        });
    }

    /** One holder's need for the browser; {@link #close()} lets it go. Idempotent; any thread. */
    public final class Lease implements AutoCloseable {
        private volatile boolean open = true;
        // Main thread only; null until an acquire() made off the main thread reaches it.
        private volatile ChromiumBindingDemand.Hold hold;

        private Lease() {}

        private void attach(ChromiumBindingDemand.Hold acquired) {
            hold = acquired;
            if (!open) acquired.close();
            else if (!acquired.isOpen()) open = false;
        }

        /** Runs {@code action} on the main thread once the hold exists, in call order. */
        private void withHold(Consumer<ChromiumBindingDemand.Hold> action) {
            onMain(() -> {
                ChromiumBindingDemand.Hold current = hold;
                if (current != null) action.accept(current);
                else handler.post(() -> action.accept(hold)); // after the queued attach
            });
        }

        /** False once closed, and from the start when the connection was already closed. */
        public boolean isOpen() {
            ChromiumBindingDemand.Hold current = hold;
            return open && (current == null || current.isOpen());
        }

        /**
         * Posts {@code callback} to the main thread once the browser service is connected,
         * passed its package and certificate check, and was asked to warm up: at once when it
         * already is, otherwise on the next such connection while this lease is open. Warmup is
         * only requested, so the first page after a cold start may still wait for Chromium to
         * initialise. The callback runs once, never inside this call, and is dropped when this
         * lease or the connection closes. It never runs when the browser refuses the binding or
         * is untrusted, so keep a deadline and close the lease at it.
         */
        public void whenReady(Runnable callback) {
            if (callback == null) throw new NullPointerException("callback");
            handler.post(() -> withHold(acquired -> acquired.whenReady(callback)));
        }

        @Override public void close() {
            open = false;
            withHold(ChromiumBindingDemand.Hold::close);
        }
    }

    /** Runs {@code task} now on the main thread, otherwise posts it there. */
    private void onMain(Runnable task) {
        if (Looper.myLooper() == handler.getLooper()) task.run();
        else handler.post(task);
    }

    private boolean isTrustedBrowser() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        return ChromiumBrowserIdentity.isTrustedPackage(BROWSER, BuildConfig.ELIZA_CHROMIUM_CERT_SHA256,
            (packageName, certificate) -> context.getPackageManager().hasSigningCertificate(
                packageName, certificate, PackageManager.CERT_INPUT_SHA256));
    }

    private final CustomTabsServiceConnection connection = new CustomTabsServiceConnection() {
        @Override public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
            if (!demand.awaitingConnection()) return;
            if (!BROWSER.equals(name.getPackageName()) || !isTrustedBrowser()) {
                Log.e(TAG, "Connected browser identity failed verification; closing the connection for good");
                demand.close();
                return;
            }
            // Initializes the browser without opening an activity, tab, URL, or debugging port.
            // Warmup is asynchronous: ready means connected, verified and warmup requested.
            boolean warmed = client.warmup(0);
            Log.i(TAG, "Verified Chromium service connected; warmup accepted=" + warmed);
            demand.connected();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            demand.disconnected();
            // Android retains this AUTO_CREATE binding and reconnects the restarted service.
            Log.w(TAG, "Chromium service disconnected; waiting for Android to reconnect");
        }

        @Override public void onBindingDied(ComponentName name) { demand.bindingLost(); }

        @Override public void onNullBinding(ComponentName name) {
            Log.w(TAG, "Chromium rejected its service binding");
            demand.bindingLost();
        }
    };

    /** Holds the binding until {@link #stop()} or {@link #close()}. */
    public void start() { onMain(demand::pin); }

    /** Ends {@link #start()}'s hold; the binding is released after the idle delay unless a lease is open. */
    public void stop() { onMain(demand::unpin); }

    /**
     * Holds the binding, binding the browser and requesting its warmup if it is not bound (at
     * once on the main thread, otherwise posted there). After {@link #close()}, including the
     * close a failed browser identity check makes, the lease is closed and binds nothing; off the
     * main thread it may turn closed only once the posted acquire runs. Check
     * {@link Lease#isOpen()}.
     */
    public Lease acquire() {
        Lease lease = new Lease();
        onMain(() -> {
            if (demand.isClosed()) Log.w(TAG, "Chromium connection is closed; lease refused");
            lease.attach(demand.acquire());
        });
        return lease;
    }

    /** Whether the browser service is connected and verified now, with warmup requested. */
    public boolean isReady() { return demand.isReady(); }

    /** Whether the connection is closed for good: by {@link #close()} or a failed identity check. */
    public boolean isClosed() { return demand.isClosed(); }

    private ChromiumBindingDemand.BindResult bindService() {
        if (!isTrustedBrowser()) {
            Log.w(TAG, "Chromium background service unavailable: package or signing certificate does not match provisioning");
            return ChromiumBindingDemand.BindResult.UNTRUSTED;
        }
        try {
            // Ordinary AndroidX binding uses WAIVE_PRIORITY, which allows the browser to freeze.
            // PreservePriority uses AUTO_CREATE: inherit the existing FGS's importance, no new permissions.
            if (CustomTabsClient.bindCustomTabsServicePreservePriority(context, BROWSER, connection))
                return ChromiumBindingDemand.BindResult.ACCEPTED;
            Log.w(TAG, "Chromium Custom Tabs service binding was not accepted");
            return ChromiumBindingDemand.BindResult.REFUSED;
        } catch (SecurityException error) {
            // error-policy:J1 Denied binding stays unavailable; do not broaden permissions or launch an activity.
            Log.e(TAG, "Chromium background service binding was denied", error);
            return ChromiumBindingDemand.BindResult.DENIED;
        }
    }

    @Override public void close() { onMain(demand::close); }
}

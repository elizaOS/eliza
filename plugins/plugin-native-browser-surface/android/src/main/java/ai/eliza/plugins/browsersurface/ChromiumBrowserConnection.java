package ai.eliza.plugins.browsersurface;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Build;
import android.os.Looper;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsServiceConnection;

/**
 * Keeps the authorized native browser reachable while its agent runs as a foreground service:
 * always after {@link #start()}, or only while a {@link Lease} is open and for an idle delay after.
 */
public final class ChromiumBrowserConnection implements AutoCloseable {
    private static final String TAG = "ElizaChromiumBinding";
    private static final String BROWSER = BuildConfig.ELIZA_CHROMIUM_PACKAGE_NAME;
    /** How long the binding outlives its last holder when the host gives no delay. */
    public static final long DEFAULT_IDLE_RELEASE_MILLIS = 60000;
    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = this::bind;
    private final Runnable idleRelease = this::releaseWhenIdle;
    private final ChromiumBindingDemand demand;
    private final List<Runnable> readyCallbacks = new ArrayList<>();
    private boolean bound;
    private boolean ready;
    private boolean closed;
    private long retryMillis = 1000;

    public ChromiumBrowserConnection(Context foregroundService) {
        this(foregroundService, DEFAULT_IDLE_RELEASE_MILLIS);
    }

    public ChromiumBrowserConnection(Context foregroundService, long idleReleaseMillis) {
        context = foregroundService;
        demand = new ChromiumBindingDemand(idleReleaseMillis);
    }

    /** One holder's need for the browser; {@link #close()} lets it go. Main thread only. */
    public final class Lease implements AutoCloseable {
        private boolean open = true;

        private Lease() {}

        @Override public void close() {
            if (!open) return;
            open = false;
            apply(demand.release());
        }
    }

    private boolean isTrustedBrowser() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        return ChromiumBrowserIdentity.isTrustedPackage(BROWSER, BuildConfig.ELIZA_CHROMIUM_CERT_SHA256,
            (packageName, certificate) -> context.getPackageManager().hasSigningCertificate(
                packageName, certificate, PackageManager.CERT_INPUT_SHA256));
    }

    private final CustomTabsServiceConnection connection = new CustomTabsServiceConnection() {
        @Override public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
            if (closed || !bound) return;
            if (!BROWSER.equals(name.getPackageName()) || !isTrustedBrowser()) {
                Log.e(TAG, "Connected browser identity failed verification; releasing binding");
                close();
                return;
            }
            retryMillis = 1000;
            // Initializes the browser without opening an activity, tab, URL, or debugging port.
            boolean warmed = client.warmup(0);
            Log.i(TAG, "Verified Chromium service connected; warmup accepted=" + warmed);
            ready = true;
            List<Runnable> waiting = new ArrayList<>(readyCallbacks);
            readyCallbacks.clear();
            for (Runnable callback : waiting) callback.run();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            ready = false;
            // Android retains this AUTO_CREATE binding and reconnects the restarted service.
            Log.w(TAG, "Chromium service disconnected; waiting for Android to reconnect");
        }

        @Override public void onBindingDied(ComponentName name) { release(); retry(); }

        @Override public void onNullBinding(ComponentName name) {
            Log.w(TAG, "Chromium rejected its service binding");
            release();
            retry();
        }
    };

    /** Holds the binding until {@link #stop()} or {@link #close()}. */
    public void start() { apply(demand.pin()); }

    /** Ends {@link #start()}'s hold; the binding is released after the idle delay unless a lease is open. */
    public void stop() { apply(demand.unpin()); }

    /** Holds the binding, binding and warming the browser now if it is not bound. */
    public Lease acquire() {
        if (closed) throw new IllegalStateException("Chromium connection is closed");
        Lease lease = new Lease();
        apply(demand.acquire());
        return lease;
    }

    /** Whether the verified browser service is connected and warmed now. */
    public boolean isReady() { return ready; }

    /**
     * Runs {@code callback} on the main thread once the verified browser service is connected:
     * now when it already is. It never runs when the binding is refused or the connection
     * closes, so a caller that must not wait forever keeps its own deadline.
     */
    public void whenReady(Runnable callback) {
        if (closed) return;
        if (ready) callback.run();
        else readyCallbacks.add(callback);
    }

    private void apply(ChromiumBindingDemand.Step step) {
        if (closed) return;
        if (step == ChromiumBindingDemand.Step.BIND) {
            handler.removeCallbacks(idleRelease);
            bind();
        } else if (step == ChromiumBindingDemand.Step.RELEASE_LATER) {
            handler.removeCallbacks(idleRelease);
            handler.postDelayed(idleRelease, demand.idleMillis());
        }
    }

    private void releaseWhenIdle() {
        if (closed || !demand.idleExpired()) return;
        handler.removeCallbacks(reconnect);
        retryMillis = 1000;
        release();
        Log.i(TAG, "Chromium binding released after its idle delay");
    }

    private void bind() {
        if (closed || bound || !demand.wanted()) return;
        if (!isTrustedBrowser()) {
            Log.w(TAG, "Chromium background service unavailable: package or signing certificate does not match provisioning");
            return;
        }
        try {
            // Ordinary AndroidX binding uses WAIVE_PRIORITY, which allows the browser to freeze.
            // PreservePriority uses AUTO_CREATE: inherit the existing FGS's importance, no new permissions.
            bound = CustomTabsClient.bindCustomTabsServicePreservePriority(context, BROWSER, connection);
            if (!bound) {
                Log.w(TAG, "Chromium Custom Tabs service binding was not accepted");
                retry();
            }
        } catch (SecurityException error) {
            // error-policy:J1 Denied binding stays unavailable; do not broaden permissions or launch an activity.
            Log.e(TAG, "Chromium background service binding was denied", error);
        }
    }

    private void retry() {
        if (closed || !demand.wanted()) return;
        handler.removeCallbacks(reconnect);
        handler.postDelayed(reconnect, retryMillis);
        retryMillis = Math.min(retryMillis * 2, 30000);
    }

    private void release() {
        ready = false;
        if (!bound) return;
        bound = false;
        context.unbindService(connection);
    }

    @Override public void close() {
        closed = true;
        readyCallbacks.clear();
        handler.removeCallbacks(reconnect);
        handler.removeCallbacks(idleRelease);
        release();
    }
}

package ai.elizaos.app;

import ai.eliza.plugins.browsersurface.ChromiumBrowserIdentity;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Build;
import android.os.Looper;
import android.util.Log;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsServiceConnection;

/** Keeps the authorized native browser reachable while its agent runs as a foreground service. */
final class ChromiumBrowserConnection implements AutoCloseable {
    private static final String TAG = "ElizaChromiumBinding";
    private static final String BROWSER = BuildConfig.ELIZA_CHROMIUM_PACKAGE_NAME;
    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = this::bind;
    private boolean bound;
    private boolean closed;
    private long retryMillis = 1000;

    ChromiumBrowserConnection(Context foregroundService) { context = foregroundService; }

    private boolean isTrustedBrowser() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        return ChromiumBrowserIdentity.isTrustedPackage(BROWSER, BuildConfig.ELIZA_CHROMIUM_CERT_SHA256,
            (packageName, certificate) -> context.getPackageManager().hasSigningCertificate(
                packageName, certificate, PackageManager.CERT_INPUT_SHA256));
    }

    private final CustomTabsServiceConnection connection = new CustomTabsServiceConnection() {
        @Override public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
            if (closed) return;
            if (!BROWSER.equals(name.getPackageName()) || !isTrustedBrowser()) {
                Log.e(TAG, "Connected browser identity failed verification; releasing binding");
                close();
                return;
            }
            retryMillis = 1000;
            // Initializes the browser without opening an activity, tab, URL, or debugging port.
            boolean warmed = client.warmup(0);
            Log.i(TAG, "Verified Chromium service connected; warmup accepted=" + warmed);
        }

        @Override public void onServiceDisconnected(ComponentName name) {
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

    void start() { bind(); }

    private void bind() {
        if (closed || bound) return;
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
        if (closed) return;
        handler.removeCallbacks(reconnect);
        handler.postDelayed(reconnect, retryMillis);
        retryMillis = Math.min(retryMillis * 2, 30000);
    }

    private void release() {
        if (!bound) return;
        bound = false;
        context.unbindService(connection);
    }

    @Override public void close() {
        closed = true;
        handler.removeCallbacks(reconnect);
        release();
    }
}

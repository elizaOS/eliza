package ai.elizaos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import app.eliza.BuildConfig;

import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "ElizaMainActivity";

    private static final int REQUEST_CODE_POST_NOTIFICATIONS = 1001;

    /**
     * One UA marker entry. The MainActivity reads `systemProp` via
     * `android.os.SystemProperties` (hidden API; reflective access from
     * the system app), and when the value is non-empty, appends
     * `<uaPrefix><value>` to the WebView's User-Agent.
     *
     * White-label forks add additional entries via
     * `app.config.ts > android.userAgentMarkers`; the
     * `run-mobile-build.mjs:overlayAndroid()` step rewrites
     * `BRAND_USER_AGENT_MARKERS` below to include them. The default
     * `ro.elizaos.product` → `ElizaOS/` entry is always emitted by the
     * framework so the renderer can sniff `isElizaOS()` consistently
     * across forks.
     */
    private static final class UserAgentMarker {
        final String systemProp;
        final String uaPrefix;

        UserAgentMarker(String systemProp, String uaPrefix) {
            this.systemProp = systemProp;
            this.uaPrefix = uaPrefix;
        }
    }

    /**
     * Brand UA markers applied during `onCreate`. The framework's
     * `ro.elizaos.product` → `ElizaOS/` entry is the default. White-label
     * forks declare additional entries via
     * `app.config.ts > android.userAgentMarkers`, which the mobile build
     * overlay rewrites in place at build time.
     */
    private static final UserAgentMarker[] BRAND_USER_AGENT_MARKERS = new UserAgentMarker[] {
        new UserAgentMarker("ro.elizaos.product", "ElizaOS/"),
        // BRAND_USER_AGENT_MARKERS_INJECTION_POINT
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Per Android docs, must precede the first WebView instantiation.
        // BridgeActivity.super.onCreate constructs the Capacitor WebView,
        // so the toggle is set first to stay race-proof against future
        // Capacitor versions that eagerly start the renderer.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        registerPlugin(AgentPlugin.class);
        registerPlugin(BatteryOptimizationPlugin.class);
        super.onCreate(savedInstanceState);

        // The Capacitor WebView serves the renderer at https://localhost
        // (its default secure-context origin); the on-device Eliza agent
        // listens at http://127.0.0.1:31337. Without this knob the WebView
        // blocks every fetch to the loopback agent as a mixed-content
        // upgrade, surfacing in the UI as "Backend Timeout: /api/auth/status
        // - Failed to fetch" even though the agent is up. Granting
        // MIXED_CONTENT_ALWAYS_ALLOW only matters for loopback in this app
        // — the network_security_config still pins the WebView's allowed
        // cleartext hosts, and the Capacitor server.hostname locks the
        // page origin.
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            applyBrandUserAgentMarkers(settings);
            // Synchronous fast path for the on-device agent bearer that
            // bypasses Capacitor's plugin executor. See ElizaNativeBridge
            // for the dead-Handler bug it works around.
            getBridge().getWebView().addJavascriptInterface(
                new ElizaNativeBridge(this), ElizaNativeBridge.JS_NAME);
        }

        // Auto-start the local Eliza agent runtime as a foreground service.
        // shouldAutoStart() returns true on branded devices (AOSP/ElizaOS —
        // the device IS the agent) and on stock Android only when the user
        // picked Local mode in onboarding. Cloud/Remote modes skip this so
        // we don't burn battery on a service they never call. The boot
        // receiver covers the cold-boot path; this is the fast path when
        // the user opens the app.
        if (ElizaAgentService.shouldAutoStart(this)) {
            ElizaAgentService.start(this);
        }

        requestPostNotificationsIfNeeded();
        ElizaWorkScheduler.enqueuePeriodic(getApplicationContext());
    }

    /**
     * On API 33+ (Tiramisu) Android requires runtime consent for posting
     * notifications. The foreground gateway service already declares the
     * permission in the manifest, but without runtime grant its notification
     * is suppressed. We request it lazily and non-blockingly here — if the
     * user denies, the FGS still runs and pushes notifications only when
     * later re-granted in system settings.
     */
    private void requestPostNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        int state = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS);
        if (state == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(
            new String[] { Manifest.permission.POST_NOTIFICATIONS },
            REQUEST_CODE_POST_NOTIFICATIONS
        );
    }

    @Override
    public void onStop() {
        super.onStop();
        if (!isFinishing()) {
            // The gateway notification is only needed to keep the Capacitor
            // gateway alive after the UI leaves the foreground. Starting it
            // during first render can trip Android's service-execution ANR on
            // slower emulator boots.
            //
            // Declared `public` (not `protected`) to match Capacitor's
            // BridgeActivity.onStop, which widens visibility from the
            // android.app.Activity superclass — overriding with weaker
            // access would be a Java compile error.
            GatewayConnectionService.start(this);
        }
    }

    @Override
    public void onDestroy() {
        // When the activity is fully destroyed (user swipe-kills the app),
        // tear down the foreground service to avoid an orphaned notification.
        // START_STICKY will restart the service if the system killed it, but
        // an explicit user-initiated destruction should respect the intent.
        if (isFinishing()) {
            GatewayConnectionService.stop(this);
        }
        super.onDestroy();
    }

    /**
     * Iterate over `BRAND_USER_AGENT_MARKERS` and append each marker's
     * `<uaPrefix><tag>` token to the WebView's User-Agent when the
     * named system property is non-empty. On stock Android no marker
     * matches and the UA is left untouched, preserving the
     * RuntimeGate picker. Idempotent — already-present markers aren't
     * duplicated.
     *
     * The framework's default `ro.elizaos.product` → `ElizaOS/` entry
     * lets the renderer sniff `isElizaOS()` consistently across
     * white-label forks; brand-specific entries are injected by the
     * mobile build overlay from `app.config.ts > android.userAgentMarkers`.
     */
    private void applyBrandUserAgentMarkers(WebSettings settings) {
        StringBuilder newUa = null;
        String currentUa = settings.getUserAgentString();
        for (UserAgentMarker marker : BRAND_USER_AGENT_MARKERS) {
            if (marker.systemProp == null || marker.systemProp.isEmpty()) {
                continue;
            }
            String tag = readSystemProperty(marker.systemProp);
            if (tag == null || tag.isEmpty()) {
                continue;
            }
            String token = marker.uaPrefix + tag;
            if (currentUa != null && currentUa.contains(token)) {
                continue;
            }
            if (newUa == null) {
                newUa = new StringBuilder(currentUa == null ? "" : currentUa);
            }
            if (newUa.length() > 0) {
                newUa.append(" ");
            }
            newUa.append(token);
        }
        if (newUa != null) {
            settings.setUserAgentString(newUa.toString());
        }
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            Log.w(TAG, "SystemProperties.get failed for " + key, e);
            return "";
        }
    }

}

package ai.elizaos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import ai.elizaos.app.BuildConfig;

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
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Install the AndroidX splash screen BEFORE super.onCreate so it swaps
        // the launch theme (AppTheme.NoActionBarLaunch / Theme.SplashScreen) to
        // the activity's postSplashScreenTheme (AppTheme.NoActionBar). Without
        // it the splash theme persists and Android renders a native AppCompat
        // action bar — the orange "Eliza" top bar with splash.png stretched
        // across it — above the Capacitor WebView.
        SplashScreen.installSplashScreen(this);

        // Per Android docs, must precede the first WebView instantiation.
        // BridgeActivity.super.onCreate constructs the Capacitor WebView,
        // so the toggle is set first to stay race-proof against future
        // Capacitor versions that eagerly start the renderer.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        registerPlugin(AgentPlugin.class);
        registerPlugin(BatteryOptimizationPlugin.class);
        registerPlugin(VoiceCapturePlugin.class);
        registerPlugin(ElizaVoicePlugin.class);
        registerPlugin(ResourceProbePlugin.class);
        super.onCreate(savedInstanceState);

        // Replace the auto-registered community PushNotifications plugin with
        // the Firebase-guarded subclass. Must run AFTER super.onCreate: the
        // bridge exists, auto-registration has happened, and
        // Bridge.registerPlugin is a plain map.put — last one wins. Without
        // this, any build lacking google-services.json hard-crashes the
        // process the moment the renderer calls PushNotifications.register()
        // with notification permission already granted.
        if (getBridge() != null) {
            getBridge().registerPlugin(SafePushNotificationsPlugin.class);
        }

        // Keep the screen on while the agent app is in the foreground.
        // Voice turns (ASR → LLM → TTS) on local-runtime builds regularly
        // take 1-5 seconds; screen-off mid-turn breaks the "is the agent
        // still working?" feedback and confuses the user. The flag is
        // window-scoped — Android releases it automatically when the window
        // is no longer visible (app moved to background or fully covered),
        // so background instances don't drain battery. Same flag set by
        // every video / voice-calling app (Snapchat, YouTube, Zoom, Meet).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Hide the bottom system navigation bar (the white gesture pill) for a
        // clean, full-bleed agent home — iOS-style. We hide ONLY the navigation
        // bars, never the status bar (the system clock/battery stay). Transient-
        // by-swipe so the user can still reveal it with an edge swipe; re-applied
        // in onWindowFocusChanged so it stays hidden after dialogs / resume.
        applyImmersiveNavigationBar();

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(resolveMixedContentMode());
            applyBrandUserAgentMarkers(settings);
            // Synchronous fast path for the on-device agent bearer that
            // bypasses Capacitor's plugin executor. See ElizaNativeBridge
            // for the dead-Handler bug it works around.
            getBridge().getWebView().addJavascriptInterface(
                new ElizaNativeBridge(this), ElizaNativeBridge.JS_NAME);
            Log.i(TAG, "startupTraceId=" + ElizaStartupTrace.currentId());
            ElizaAndroidSystemBridge.install(getBridge().getWebView(), this);
            publishGestureInset();
        }

        // Auto-start the local Eliza agent runtime as a foreground service.
        // shouldAutoStart() returns true on branded devices (AOSP/ElizaOS —
        // the device IS the agent), on stock Android when the user picked
        // Local mode in onboarding, and on a fresh install of any build that
        // ships the agent payload — the renderer pre-seeds the on-device
        // agent as its backend on first paint, so the payload build must
        // start it here or the first launch polls a socket no one serves
        // (#15189). Explicit Cloud/Remote choices skip this so we don't burn
        // battery on a service they never call. The boot receiver covers the
        // cold-boot path; this is the fast path when the user opens the app.
        if (ElizaAgentService.shouldAutoStart(this)) {
            ElizaAgentService.start(this);
            // Ask for notification consent only once the user (or the device
            // image) has actually committed to running the on-device agent.
            // A fresh install runs the pre-seeded agent before any recorded
            // choice — keep first paint free of a cold permission ask and let
            // onboarding own that moment.
            if (ElizaAgentService.hasCommittedRuntimeChoice(this)) {
                requestPostNotificationsIfNeeded();
            }
        }

        ElizaWorkScheduler.enqueuePeriodic(getApplicationContext());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The system restores the nav bar after dialogs / resume; re-hide it
        // whenever we regain focus so the full-bleed home stays clean.
        if (hasFocus) {
            applyImmersiveNavigationBar();
        }
    }

    /**
     * Hide the bottom navigation bar (gesture pill) while keeping the status
     * bar. Uses the AndroidX controller so it is correct across API levels;
     * transient-by-swipe so the bar is still reachable.
     */
    private void applyImmersiveNavigationBar() {
        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(
                    getWindow(), getWindow().getDecorView());
            if (controller != null) {
                controller.hide(WindowInsetsCompat.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat
                        .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                // The status bar stays visible over the live orange ambient
                // home, so its icons must be light (white). Paired with the
                // transparent android:statusBarColor in styles.xml, the orange
                // draws full-bleed under the clock/battery — no flat band.
                controller.setAppearanceLightStatusBars(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to apply immersive navigation bar", e);
        }
    }

    /**
     * Publish the bottom gesture-navigation inset (the home-pill zone apps must
     * not put critical UI under) to the WebView as the CSS var
     * `--android-gesture-inset-bottom`. We hide the navigation bar, which zeroes
     * `env(safe-area-inset-bottom)`, so the floating chat composer would
     * otherwise sit on top of the gesture-home zone. The renderer folds this var
     * into its bottom clearance via max(); it defaults to 0px off-Android.
     */
    private void publishGestureInset() {
        final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(
            getWindow().getDecorView(),
            (v, insets) -> {
                int px = insets
                    .getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
                    .bottom;
                float dp = px / getResources().getDisplayMetrics().density;
                String js =
                    "document.documentElement.style.setProperty("
                        + "'--android-gesture-inset-bottom','" + dp + "px')";
                webView.post(() -> webView.evaluateJavascript(js, null));
                return insets;
            });
        ViewCompat.requestApplyInsets(getWindow().getDecorView());
    }

    private static int resolveMixedContentMode() {
        // The local/AOSP app serves the renderer from Capacitor's
        // https://localhost origin while the on-device agent listens on
        // http://127.0.0.1:31337. Debug sideload builds and privileged AOSP
        // builds need that loopback bridge; cloud/Play rewrites this
        // activity and keeps mixed content blocked.
        if (BuildConfig.DEBUG || BuildConfig.AOSP_BUILD) {
            return WebSettings.MIXED_CONTENT_ALWAYS_ALLOW;
        }
        return WebSettings.MIXED_CONTENT_NEVER_ALLOW;
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
     * matches and the UA is left untouched, preserving first-run runtime
     * setup. Idempotent — already-present markers aren't
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

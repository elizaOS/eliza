/** Renders the Android main activity Java source for cloud-safe mobile builds. */

export function cloudSafeMainActivityJava(
  androidPackage,
  {
    launcherKiosk = false,
    immersiveNavigation = false,
    safePushNotifications = true,
  } = {},
) {
  const launcherImports = launcherKiosk
    ? `import android.app.admin.DevicePolicyManager;
import android.net.Uri;
import android.util.Log;
import android.view.KeyEvent;

import androidx.activity.OnBackPressedCallback;
`
    : "";
  const navigationInsetsImport = immersiveNavigation
    ? "import androidx.core.view.WindowInsetsCompat;\n"
    : "";
  const launcherConstants = launcherKiosk
    ? '    private static final String TAG = "ElizaMainActivity";\n'
    : "";
  const launcherSetup = launcherKiosk
    ? `
        // The launcher owns the device surface. Lifecycle-bound Back callbacks
        // are added on every start in registration order and the last one
        // wins, so this one, registered after super.onCreate, runs instead of
        // the Capacitor App plugin's. That plugin would minimize the launcher
        // task or walk WebView history back through Cloud/OAuth pages. Give
        // the page only its back intent, so an open sheet closes, and
        // otherwise stay on the launcher root.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().eval(
                    "window.dispatchEvent(new CustomEvent('eliza:back-intent', { detail: { handled: false } }))",
                    null);
            }
        });
`
    : "";
  const launcherMethods = launcherKiosk
    ? `
    private void enterManagedLockTaskIfPermitted() {
        DevicePolicyManager policy = getSystemService(DevicePolicyManager.class);
        if (policy == null || !policy.isLockTaskPermitted(getPackageName())) {
            return;
        }
        try {
            startLockTask();
        } catch (IllegalArgumentException | IllegalStateException | SecurityException e) {
            Log.w(TAG, "Unable to enter managed launcher lock-task mode", e);
        }
    }

    private boolean isCloudAuthCallback(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        return data != null
            && "elizaos".equalsIgnoreCase(data.getScheme())
            && "auth".equalsIgnoreCase(data.getHost())
            && "/callback".equals(data.getPath());
    }

    private void restoreBundledRendererAfterAuthCallback(Intent intent) {
        if (!isCloudAuthCallback(intent)
                || rendererGone
                || getBridge() == null
                || getBridge().getWebView() == null) {
            return;
        }
        WebView webView = getBridge().getWebView();
        String localUrl = getBridge().getLocalUrl();
        webView.post(() -> webView.loadUrl(localUrl));
    }

    @Override
    public void onResume() {
        super.onResume();
        keepScreenAwake();
        // Only a managed-device owner may contain the launcher task. Android's
        // unmanaged screen-pinning mode blocks the secure browser that Google
        // OAuth requires, preventing the callback from ever reaching the app.
        enterManagedLockTaskIfPermitted();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Keep hardware keyboards and accessibility navigation from moving the
        // launcher WebView forward through browser history.
        if (event.getKeyCode() == KeyEvent.KEYCODE_FORWARD
                || event.getKeyCode() == KeyEvent.KEYCODE_NAVIGATE_NEXT) {
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
`
    : "";
  const resumeHandler = launcherKiosk
    ? ""
    : `
    @Override
    public void onResume() {
        super.onResume();
        keepScreenAwake();
    }
`;
  const navigationBarPolicy = immersiveNavigation
    ? `            systemBars.hide(WindowInsetsCompat.Type.navigationBars());
            systemBars.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);`
    : "            systemBars.setAppearanceLightNavigationBars(false);";
  const focusHandler = `
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        keepScreenAwake();
${
  immersiveNavigation
    ? `
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(
                getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.navigationBars());
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
`
    : ""
}    }
`;
  const safePushRegistration = safePushNotifications
    ? `
        // Appended after discovery, before the first bridge JS/header export.
        initialPlugins.add(SafePushNotificationsPlugin.class);
`
    : "";
  return `package ${androidPackage};

import android.os.Bundle;
import android.content.Intent;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.WindowManager;

import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
${navigationInsetsImport}import androidx.core.view.WindowInsetsControllerCompat;
${launcherImports}

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import ${androidPackage}.BuildConfig;

public class MainActivity extends BridgeActivity {
${launcherConstants}
    // Set when Android ends the WebView renderer. The dead WebView is never
    // used again; the activity is recreated with a new one on its next start.
    private boolean rendererGone;
    private boolean started;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The launch theme's postSplashScreenTheme is applied only when the
        // AndroidX splash lifecycle is installed before BridgeActivity builds
        // the WebView. Otherwise the splash theme keeps a native action bar
        // over the top of the cloud client for the activity's lifetime.
        SplashScreen.installSplashScreen(this);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        DeepLinkBufferPlugin.captureIntent(this, getIntent());
        registerPlugin(DeepLinkBufferPlugin.class);
        registerPlugin(ElizaSecureCredentialsPlugin.class);
        registerPlugin(ElizaPlayExportPlugin.class);
        registerPlugin(ElizaPlayVoicePlugin.class);
        registerPlugin(ElizaPlaySettingsPlugin.class);

${safePushRegistration}
        super.onCreate(savedInstanceState);
        keepScreenAwake();

${launcherSetup}
        // Draw the canonical Cloud renderer behind transparent system bars. The
        // launcher variant hides only the navigation bar; a swipe can reveal
        // it transiently; ordinary Cloud builds keep both bars visible.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat systemBars =
            WindowCompat.getInsetsController(
                getWindow(), getWindow().getDecorView());
        if (systemBars != null) {
            systemBars.setAppearanceLightStatusBars(false);
${navigationBarPolicy}
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            // Android can end the renderer for memory while the screen is off.
            // An unhandled renderer death makes WebView kill the whole app
            // process, and any foreground service in it. Remove and destroy
            // the dead WebView instead, and recreate the activity when it is
            // next started (at once if it is on screen), so a new renderer
            // does not start into the same memory pressure.
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(
                        WebView view, RenderProcessGoneDetail detail) {
                    rendererGone = true;
                    if (view.getParent() instanceof ViewGroup) {
                        ((ViewGroup) view.getParent()).removeView(view);
                    }
                    view.destroy();
                    if (started) recreate();
                    return true;
                }
            });
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        DeepLinkBufferPlugin.captureIntent(this, intent);
        super.onNewIntent(intent);
${launcherKiosk ? "        restoreBundledRendererAfterAuthCallback(intent);" : ""}
    }
${launcherMethods}
${resumeHandler}
${focusHandler}

    // Screen off stops the activity but can leave its window visible, so the
    // page would keep document.visibilityState "visible". WebView.onPause marks
    // the page hidden; JavaScript keeps running. Use onStop, not onPause, so a
    // permission dialog over the visible app does not hide the page.
    @Override
    public void onStart() {
        super.onStart();
        started = true;
        if (rendererGone) {
            recreate();
            return;
        }
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
        }
    }

    @Override
    public void onStop() {
        started = false;
        if (!rendererGone
                && getBridge() != null
                && getBridge().getWebView() != null) {
            getBridge().getWebView().onPause();
        }
        super.onStop();
    }

    private void keepScreenAwake() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

}
`;
}

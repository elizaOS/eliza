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
        // The launcher owns the device surface. Keep Back from finishing the
        // root activity, then enter Android lock-task mode. A managed device
        // owner can allowlist this package for silent kiosk; an unmanaged
        // Pixel receives Android's recoverable screen-pinning confirmation.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Intentionally stay on the launcher root.
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
        // Capacitor discovers the community push plugin before Firebase is
        // available in builds without google-services.json. Replace it after
        // bridge creation so registration reports unavailable instead of
        // terminating the process when the renderer requests notifications.
        if (getBridge() != null) {
            getBridge().registerPlugin(SafePushNotificationsPlugin.class);
        }
`
    : "";
  return `package ${androidPackage};

import android.os.Bundle;
import android.content.Intent;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.WindowManager;

import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
${navigationInsetsImport}import androidx.core.view.WindowInsetsControllerCompat;
${launcherImports}

import com.getcapacitor.BridgeActivity;

import ${androidPackage}.BuildConfig;

public class MainActivity extends BridgeActivity {
${launcherConstants}

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

        super.onCreate(savedInstanceState);
        keepScreenAwake();
${safePushRegistration}

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

    private void keepScreenAwake() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

}
`;
}

/** Renders the Android main activity Java source for cloud-safe mobile builds. */

export function cloudSafeMainActivityJava(
  androidPackage,
  { safePushNotifications = true } = {},
) {
  const safePushRegistration = safePushNotifications
    ? `
        // Appended after discovery, before the first bridge JS/header export.
        initialPlugins.add(SafePushNotificationsPlugin.class);
`
    : "";
  return `package ${androidPackage};

import android.os.Bundle;
import android.content.Intent;
import android.webkit.WebView;
import android.view.WindowManager;

import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import ai.eliza.plugins.browsersurface.ElizaBridgeActivity;

import ${androidPackage}.BuildConfig;

// ElizaBridgeActivity owns the shared WebView lifecycle: no mixed content,
// renderer-death recovery and the stopped-page pause.
public class MainActivity extends ElizaBridgeActivity {
    private Intent initialDeepLinkIntent;
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

        initialDeepLinkIntent = getIntent();
        DeepLinkBufferPlugin.captureIntent(this, initialDeepLinkIntent);
        registerPlugin(DeepLinkBufferPlugin.class);
        registerPlugin(ElizaSecureCredentialsPlugin.class);
        // Native Eliza Cloud sign-in (email code, SMS code, native Google).
        registerPlugin(ElizaCloudSignInPlugin.class);
        // Appended after generated plugin discovery, preserving the credential intent boundary.
        initialPlugins.add(ElizaSecureStorePlugin.class);
        registerPlugin(ElizaPlayExportPlugin.class);
        registerPlugin(ElizaPlayVoicePlugin.class);
        registerPlugin(ElizaPlaySettingsPlugin.class);

${safePushRegistration}
        super.onCreate(savedInstanceState);
        keepScreenAwake();

        // Draw the canonical Cloud renderer behind transparent system bars.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat systemBars =
            WindowCompat.getInsetsController(
                getWindow(), getWindow().getDecorView());
        if (systemBars != null) {
            systemBars.setAppearanceLightStatusBars(false);
            systemBars.setAppearanceLightNavigationBars(false);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (intent != initialDeepLinkIntent) DeepLinkBufferPlugin.captureIntent(this, intent);
        initialDeepLinkIntent = null;
        super.onNewIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        keepScreenAwake();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        keepScreenAwake();
    }

    private void keepScreenAwake() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

}
`;
}

package ai.elizaos.app;

import android.os.Bundle;
import android.content.Intent;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

import ai.elizaos.app.BuildConfig;

public class MainActivity extends BridgeActivity {

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

        super.onCreate(savedInstanceState);

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        DeepLinkBufferPlugin.captureIntent(this, intent);
        super.onNewIntent(intent);
    }

}

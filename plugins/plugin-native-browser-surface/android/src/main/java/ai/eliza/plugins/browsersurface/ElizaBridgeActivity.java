package ai.eliza.plugins.browsersurface;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * Shared WebView lifecycle for an app's main Capacitor activity.
 *
 * <ul>
 *   <li>The bridge WebView never loads mixed content.</li>
 *   <li>When Android ends the WebView renderer (for example for memory while the
 *       screen is off), an unhandled renderer death makes WebView kill the whole
 *       app process, and any foreground service in it. This activity removes and
 *       destroys the dead WebView instead, and recreates itself when it is next
 *       started (at once if it is on screen), so a new renderer does not start
 *       into the same memory pressure.</li>
 *   <li>Screen off stops the activity but can leave its window visible, so the
 *       page would keep document.visibilityState "visible". WebView.onPause marks
 *       the page hidden; JavaScript keeps running. onStop is used, not onPause,
 *       so a permission dialog over the visible app does not hide the page.</li>
 * </ul>
 *
 * A subclass registers its plugins before calling {@code super.onCreate}. After
 * the renderer is gone, it must not use the bridge WebView: check
 * {@link #isRendererGone()} first.
 */
public class ElizaBridgeActivity extends BridgeActivity {
    // Set when Android ends the WebView renderer. The dead WebView is never
    // used again; the activity is recreated with a new one on its next start.
    private boolean rendererGone;
    private boolean started;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().getSettings()
            .setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(
                    WebView view, RenderProcessGoneDetail detail) {
                rendererGone = true;
                onRendererGone();
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
                view.destroy();
                if (started) recreate();
                return true;
            }
        });
    }

    /** True after the WebView renderer ended; the bridge WebView is destroyed. */
    protected final boolean isRendererGone() {
        return rendererGone;
    }

    /**
     * Called when the renderer ends, before the dead WebView is destroyed and
     * before any recreate. The default does nothing.
     */
    protected void onRendererGone() {}

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
}

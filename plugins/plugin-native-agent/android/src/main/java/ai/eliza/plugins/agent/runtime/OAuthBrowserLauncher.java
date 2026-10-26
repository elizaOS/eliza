package ai.eliza.plugins.agent.runtime;

import android.content.Intent;
import android.net.Uri;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import java.net.URI;
import java.util.Objects;

/** Opens an authorization address in an Auth Tab when the browser supports it, else a Custom Tab.
 * An Auth Tab hands the HTTPS redirect back as an activity result, which goes to the
 * {@link PrivateOAuthCallback}. When the browser cannot verify the redirect host for this app,
 * the same address reopens in a Custom Tab. Custom Tab returns arrive as host App Link intents,
 * which the host passes to the same callback. The result URI is never logged or kept.
 */
public final class OAuthBrowserLauncher {
  /** The Auth Tab closed without an admitted callback. */
  @FunctionalInterface public interface Closed { void closed(); }
  private final ComponentActivity activity;
  private final PrivateOAuthCallback callback;
  private final ActivityResultLauncher<Intent> authTab;
  private Uri pending;
  private String pendingBrowser;

  /** Construct in {@code onCreate}: the Activity Result API registers before the activity starts. */
  public OAuthBrowserLauncher(ComponentActivity activity, PrivateOAuthCallback callback, Closed closed) {
    this.activity = Objects.requireNonNull(activity);
    this.callback = Objects.requireNonNull(callback);
    Objects.requireNonNull(closed);
    this.authTab = AuthTabIntent.registerActivityResultLauncher(activity, result -> {
      Uri address = pending;
      String browser = pendingBrowser;
      pending = null;
      pendingBrowser = null;
      if (result.resultCode == AuthTabIntent.RESULT_OK && result.resultUri != null) {
        if (callback.accept(result.resultUri.toString()) != PrivateOAuthCallback.Admission.QUEUED) closed.closed();
      } else if ((result.resultCode == AuthTabIntent.RESULT_VERIFICATION_FAILED ||
          result.resultCode == AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT) && address != null) {
        openCustomTab(address, browser);
      } else {
        closed.closed();
      }
    });
  }

  /** Opens {@code authorize} in {@code browser}, or the default Custom Tabs browser when null.
   * Returns false when no browser supports Custom Tabs. Call on the main thread. */
  public boolean launch(Uri authorize, String browser) {
    Objects.requireNonNull(authorize);
    String target = browser != null ? browser : CustomTabsClient.getPackageName(activity, null);
    if (target == null) return false;
    if (CustomTabsClient.isAuthTabSupported(activity, target)) {
      URI redirect = callback.redirect();
      AuthTabIntent intent = new AuthTabIntent.Builder().build();
      intent.intent.setPackage(target);
      pending = authorize;
      pendingBrowser = target;
      intent.launch(authTab, authorize, redirect.getHost(), redirect.getRawPath());
    } else {
      openCustomTab(authorize, target);
    }
    return true;
  }

  private void openCustomTab(Uri authorize, String browser) {
    CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
    tab.intent.setPackage(browser);
    tab.launchUrl(activity, authorize);
  }
}

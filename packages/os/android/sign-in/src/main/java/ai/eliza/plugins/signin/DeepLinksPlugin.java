// spec/os/android/deepLinks.md, "Story: Open the link I followed exactly once, even across a cold start"; spec/os/android/deepLinks.md, "Story: Keep two links I followed apart, even when they are the same URL"
package ai.eliza.plugins.signin;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "ElizaDeepLinks")
public class DeepLinksPlugin extends Plugin {
  private static final String TAG = "ElizaDeepLinks";
  private static final String EXTRA_RECEIPT = "ai.eliza.plugins.signin.DEEP_LINK_RECEIPT";
  private static final Object PROCESS = new Object();
  private static DeepLinkCapture capture;

  @Override public void load() {
    Intent launch = getActivity().getIntent();
    try {
      synchronized (PROCESS) {
        if (capture == null) {
          KeystoreSlot slot = new KeystoreSlot(getContext(), KeystoreSlot.DEEP_LINK);
          capture = DeepLinkCapture.launch(slot, null);
          capture = DeepLinkCapture.launch(slot, uncaptured(launch));
          if (capture.coldLaunch() > 0) launch.putExtra(EXTRA_RECEIPT, capture.coldLaunch());
          return;
        }
      }
      captureIntent(launch);
    } catch (Exception failure) {
      Log.e(TAG, "A followed link could not be kept", failure);
    }
  }

  @Override protected void handleOnNewIntent(Intent intent) {
    super.handleOnNewIntent(intent);
    try {
      long receipt = captureIntent(intent);
      if (receipt > 0) notifyListeners("linkCaptured", link(receipt, intent.getData().toString()), true);
    } catch (Exception failure) {
      Log.e(TAG, "A followed link could not be kept", failure);
    }
  }

  private static String uncaptured(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.hasExtra(EXTRA_RECEIPT)) return null;
    Uri data = intent.getData();
    String url = data == null ? null : data.toString();
    return DeepLinkCapture.admissible(url) ? url : null;
  }

  private long captureIntent(Intent intent) throws Exception {
    String url = uncaptured(intent);
    if (url == null) return 0;
    long receipt = current().capture(url);
    intent.putExtra(EXTRA_RECEIPT, receipt);
    return receipt;
  }

  private static DeepLinkCapture current() {
    synchronized (PROCESS) { return capture; }
  }

  private static JSObject link(long receipt, String url) {
    JSObject link = new JSObject();
    link.put("receipt", receipt);
    link.put("url", url);
    return link;
  }

  @PluginMethod public void pending(PluginCall call) {
    try {
      DeepLinkCapture.Pending pending = current().pending();
      JSObject result = new JSObject();
      result.put("link", pending == null ? JSONObject.NULL : link(pending.receipt(), pending.url()));
      call.resolve(result);
    } catch (Exception failure) {
      call.reject("The followed link could not be read", "storage", failure);
    }
  }

  @PluginMethod public void acknowledge(PluginCall call) {
    Long receipt = call.getLong("receipt");
    String url = call.getString("url");
    if (receipt == null || receipt < 1 || !DeepLinkCapture.admissible(url)) {
      call.reject("receipt and url are required", "invalid");
      return;
    }
    try {
      JSObject result = new JSObject();
      result.put("cleared", current().acknowledge(receipt, url));
      call.resolve(result);
    } catch (Exception failure) {
      call.reject("The followed link could not be acknowledged", "storage", failure);
    }
  }
}

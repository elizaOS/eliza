package ai.elizaos.app;

import android.content.Intent;
import android.net.Uri;
import com.capacitorjs.plugins.app.AppPlugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Adds capture identity to the existing retained App event channel. */
@CapacitorPlugin(name = "App")
public final class ReceiptAppPlugin extends AppPlugin {
    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri url = intent.getData();
        if (url == null) return;
        // AppPlugin 8.1.1 performs only this ACTION_VIEW event projection here.
        // Calling its handler as well would emit the navigation a second time.
        JSObject result = new JSObject();
        result.put("url", url.toString());
        String receipt = DeepLinkBufferPlugin.capturedReceipt(intent);
        if (receipt != null) result.put("receiptId", receipt);
        notifyListeners("appUrlOpen", result, true);
    }
}

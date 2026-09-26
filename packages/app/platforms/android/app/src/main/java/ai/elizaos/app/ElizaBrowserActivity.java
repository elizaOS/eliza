/**
 * Routes Android website intents into the installed full Chromium browser.
 * Pinning the provider prevents recursion through Eliza's own ACTION_VIEW
 * handler and keeps authentication in the browser's persistent profile.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.os.Bundle;
import ai.eliza.plugins.browsersurface.BrowserLaunchException;
import ai.eliza.plugins.browsersurface.ChromiumBrowserLauncher;

public class ElizaBrowserActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Uri data = getIntent() != null ? getIntent().getData() : null;
        try {
            ChromiumBrowserLauncher.launch(this, data != null ? data.toString() : "");
            finish();
        } catch (BrowserLaunchException error) {
            // error-policy:J1 Show native launch failures instead of an empty browser.
            showFailure(error.getMessage());
        } catch (ActivityNotFoundException | SecurityException error) {
            // error-policy:J1 Android can revoke browser availability during dispatch.
            showFailure("Chromium could not open this website. Enable or repair the system browser and try again.");
        }
    }

    private void showFailure(String message) {
        new AlertDialog.Builder(this)
                .setTitle("Unable to open browser")
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }
}

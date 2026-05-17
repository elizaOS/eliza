package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;

/**
 * Camera entry point.
 *
 * AOSP Camera2 is stripped. The hardware camera HAL stays, but the
 * stock camera UI does not. This activity captures both:
 *   - User taps "Camera" in the launcher (LAUNCHER intent).
 *   - Another app fires IMAGE_CAPTURE / VIDEO_CAPTURE / STILL_IMAGE_CAMERA.
 *
 * For the LAUNCHER case we route to the Eliza camera surface. For
 * IMAGE_CAPTURE the WebView sees the EXTRA_OUTPUT URI and is responsible
 * for writing the captured frame back to that URI before calling
 * setResult — the standard contract that other apps expect.
 */
public class ElizaCameraActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String action = source != null ? source.getAction() : null;
        Uri output = source != null
                ? source.getParcelableExtra(MediaStore.EXTRA_OUTPUT)
                : null;

        Uri.Builder route = Uri.parse("ai.elizaos.app://camera").buildUpon()
                .appendQueryParameter("source", "android-camera");
        if (action != null) {
            route.appendQueryParameter("action", action);
        }
        if (output != null) {
            route.appendQueryParameter("output", output.toString());
        }

        // ACTION_IMAGE_CAPTURE expects the launching app to receive a
        // result via setResult(RESULT_OK, ...). The WebView signals the
        // capture URI back via a Capacitor bridge call which lands on
        // a separate code path; here we just open the surface.
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}

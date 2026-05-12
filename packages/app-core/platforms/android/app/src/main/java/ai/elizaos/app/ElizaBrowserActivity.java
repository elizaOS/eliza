package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;

/**
 * Browser entry point.
 *
 * Browser2 is stripped from ElizaOS, so without this activity any
 * external app firing ACTION_VIEW on an http(s) URL would land in
 * "No activity found to handle Intent." Eliza is the system browser
 * by being the only handler for these schemes; the actual page render
 * happens inside the WebView at the eliza://browse?url= deep link.
 */
public class ElizaBrowserActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        Uri data = source != null ? source.getData() : null;
        Uri.Builder route = Uri.parse("ai.elizaos.app://browse").buildUpon()
                .appendQueryParameter("source", "android-view");
        if (data != null && !TextUtils.isEmpty(data.toString())) {
            route.appendQueryParameter("url", data.toString());
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}

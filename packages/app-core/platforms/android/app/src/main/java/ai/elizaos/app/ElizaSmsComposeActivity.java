package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;

public class ElizaSmsComposeActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        Uri data = source != null ? source.getData() : null;
        String recipient = data != null ? data.getSchemeSpecificPart() : null;
        if (recipient != null) {
            int queryIndex = recipient.indexOf('?');
            if (queryIndex >= 0) {
                recipient = recipient.substring(0, queryIndex);
            }
            recipient = Uri.decode(recipient);
        }

        String body = null;
        if (source != null) {
            body = source.getStringExtra(Intent.EXTRA_TEXT);
            if (TextUtils.isEmpty(body)) {
                body = source.getStringExtra("sms_body");
            }
        }

        Uri.Builder route = Uri.parse("ai.elizaos.app://messages/compose").buildUpon()
                .appendQueryParameter("source", "android-sendto");
        if (!TextUtils.isEmpty(recipient)) {
            route.appendQueryParameter("recipient", recipient);
        }
        if (!TextUtils.isEmpty(body)) {
            route.appendQueryParameter("body", body);
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}

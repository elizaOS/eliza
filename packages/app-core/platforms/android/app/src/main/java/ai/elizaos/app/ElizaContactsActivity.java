package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Contacts entry point.
 *
 * Stock AOSP Contacts is stripped. Eliza owns contacts via the
 * platform's ContactsContract provider (which AOSP keeps even when
 * the Contacts UI is removed), and this activity surfaces the
 * Eliza contacts view for both the launcher entry and external
 * ACTION_VIEW intents on people:/contacts: URIs.
 *
 * Common triggers:
 *   - User taps "View contact" on a vCard from email/messaging.
 *   - Another app opens content://com.android.contacts/contacts/123.
 *   - User selects "Contacts" from the app drawer (LAUNCHER intent).
 */
public class ElizaContactsActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        Uri data = source != null ? source.getData() : null;
        String action = source != null ? source.getAction() : null;

        Uri.Builder route = Uri.parse("ai.elizaos.app://contacts").buildUpon()
                .appendQueryParameter("source", "android-contacts");
        if (action != null) {
            route.appendQueryParameter("action", action);
        }
        if (data != null) {
            route.appendQueryParameter("uri", data.toString());
            String authority = data.getAuthority();
            if (authority != null) {
                route.appendQueryParameter("authority", authority);
            }
            String lastSegment = data.getLastPathSegment();
            if (lastSegment != null) {
                route.appendQueryParameter("contactId", lastSegment);
            }
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}

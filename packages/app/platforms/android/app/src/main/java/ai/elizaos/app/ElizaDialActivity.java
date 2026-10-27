package ai.elizaos.app;

import ai.eliza.plugins.phone.TelecomDial;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

/**
 * Default dialer entry point.
 *
 * Receives ACTION_DIAL (open the dial pad) and ACTION_CALL (place a call
 * directly). For ACTION_DIAL we forward to the WebView which renders the
 * Eliza dial pad. For ACTION_CALL with a tel: URI we invoke
 * {@link TelecomManager#placeCall} so the framework actually originates
 * the outgoing call — without this, Eliza would be a dialer UI that
 * never dials anything.
 *
 * The InCallService then receives the resulting Call object and owns
 * the native call screen independently of WebView and agent startup.
 */
public class ElizaDialActivity extends Activity {

    private static final String TAG = "ElizaDialActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String action = source != null ? source.getAction() : null;
        Uri data = source != null ? source.getData() : null;

        if (Intent.ACTION_CALL.equals(action) && data != null && "tel".equals(data.getScheme())) {
            originateCall(data);
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        Uri.Builder route = Uri.parse("elizaos://phone").buildUpon()
                .appendQueryParameter("source", "android-dial");
        if (action != null) {
            route.appendQueryParameter("action", action);
        }
        if (data != null) {
            route.appendQueryParameter("uri", data.toString());
        }
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }

    /**
     * Places an outgoing call through the shared {@link TelecomDial}. A refusal (no dialer role or
     * CALL_PHONE) is logged; the WebView still opens and the user can re-attempt manually.
     */
    private void originateCall(Uri telUri) {
        TelecomDial.Outcome outcome = TelecomDial.originate(this, telUri);
        if (outcome != TelecomDial.Outcome.PLACED) Log.w(TAG, "ACTION_CALL not placed: " + outcome);
    }
}

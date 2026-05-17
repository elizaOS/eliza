package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
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
 * The InCallService then receives the resulting Call object and routes
 * the in-call UI back into the WebView via deep link.
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
        Uri.Builder route = Uri.parse("ai.elizaos.app://phone").buildUpon()
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
     * Place an outgoing call via the platform's TelecomManager. The
     * MANAGE_OWN_CALLS / CALL_PHONE permissions cover this; on a
     * privileged install both are auto-granted via default-permissions.
     *
     * Failures here are recoverable — the WebView still opens and the
     * user can re-attempt manually — so we log instead of throwing.
     */
    private void originateCall(Uri telUri) {
        TelecomManager telecom = (TelecomManager) getSystemService(TELECOM_SERVICE);
        if (telecom == null) {
            Log.w(TAG, "TelecomManager unavailable; ACTION_CALL not honored.");
            return;
        }
        try {
            Bundle extras = new Bundle();
            PhoneAccountHandle defaultAccount =
                    telecom.getDefaultOutgoingPhoneAccount(telUri.getScheme());
            if (defaultAccount != null) {
                extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, defaultAccount);
            }
            telecom.placeCall(telUri, extras);
            Log.i(TAG, "Originated call to " + telUri);
        } catch (SecurityException error) {
            Log.w(TAG, "placeCall denied; CALL_PHONE not granted.", error);
        }
    }
}

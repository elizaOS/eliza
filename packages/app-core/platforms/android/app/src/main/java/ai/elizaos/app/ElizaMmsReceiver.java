package ai.elizaos.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;

/**
 * Receives WAP-push (MMS notification-IND) broadcasts. Owning this receiver
 * is required to hold the SMS role; without it PermissionController will
 * not assign android.app.role.SMS to this package.
 *
 * Full MMS retrieval requires PduParser/PduPersister from
 * frameworks/opt/telephony, which are hidden API. On a privileged system
 * install those are reachable at runtime, but the Capacitor app builds
 * against the public SDK so we can only:
 *   1. Pull the raw PDU bytes from the intent.
 *   2. Hand them to the JS layer via a deep link, base64-encoded.
 *   3. Log the event structurally so logcat shows it isn't silently lost.
 *
 * The JS layer is responsible for parsing the PDU (or scheduling
 * MmsManager.downloadMultimediaMessage if/when that path is wired up).
 */
public class ElizaMmsReceiver extends BroadcastReceiver {

    private static final String TAG = "ElizaMmsReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        long receivedAt = System.currentTimeMillis();

        byte[] pdu = intent != null ? intent.getByteArrayExtra("data") : null;
        String format = intent != null ? intent.getStringExtra("format") : null;
        int subscription = intent != null
                ? intent.getIntExtra("subscription", -1)
                : -1;

        Log.i(TAG,
                "WAP_PUSH_DELIVER received: bytes="
                        + (pdu != null ? pdu.length : 0)
                        + " format=" + (format != null ? format : "<null>")
                        + " subscription=" + subscription);

        Uri.Builder route = Uri.parse("ai.elizaos.app://messages").buildUpon()
                .appendQueryParameter("event", "mms-deliver")
                .appendQueryParameter("retrieval", "deferred")
                .appendQueryParameter("timestamp", Long.toString(receivedAt));
        if (!TextUtils.isEmpty(format)) {
            route.appendQueryParameter("format", format);
        }
        if (subscription >= 0) {
            route.appendQueryParameter("subscription", Integer.toString(subscription));
        }
        if (pdu != null && pdu.length > 0) {
            route.appendQueryParameter("pduSize", Integer.toString(pdu.length));
            route.appendQueryParameter(
                    "pduBase64",
                    Base64.encodeToString(pdu, Base64.NO_WRAP));
        }

        Intent launch = new Intent(context, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(launch);
    }
}

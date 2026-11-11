package ai.eliza.plugins.messages.vvm;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.VoicemailContract;
import android.util.Log;

/**
 * The broadcasts the visual-voicemail client answers, declared by the host as a subclass:
 * {@link VoicemailContract#ACTION_FETCH_VOICEMAIL} (download one row's audio, as
 * {@code VoicemailStore.fetch} asks), {@link VoicemailContract#ACTION_SYNC_VOICEMAIL} (push what the
 * owner heard or deleted, pull the rest) and the radio's result for this client's own requests.
 *
 * The work is handed to {@link VvmController}'s worker and runs in this process after
 * {@code onReceive} returns. It is not a scheduled job: if the process ends first the request is
 * lost, the row stays as it was, and the next request, SYNC notice or return of service does it.
 */
@androidx.annotation.RequiresApi(29)
public abstract class VisualVoicemailReceiver extends BroadcastReceiver {
 private static final String TAG = "VisualVoicemail";
 static final String ACTION_REQUEST_SENT = "ai.eliza.plugins.messages.vvm.REQUEST_SENT";
 static final String EXTRA_COMPONENT = "ai.eliza.plugins.messages.vvm.COMPONENT", EXTRA_ID = "ai.eliza.plugins.messages.vvm.ID";
 private static final Runnable NOTHING = () -> { };

 /** The host's identity; the same value its {@link VisualVoicemailClientService} returns. */
 protected abstract VvmConfiguration configuration();

 @Override public void onReceive(Context context, Intent intent) {
  String action = intent == null ? null : intent.getAction();
  if (action == null) return;
  try {
   VvmController controller = VvmController.get(context, configuration());
   if (VoicemailContract.ACTION_FETCH_VOICEMAIL.equals(action)) {
    Uri row = intent.getData();
    long id = row != null && VoicemailContract.AUTHORITY.equals(row.getAuthority()) ? ImapClient.positive(row.getLastPathSegment()) : -1;
    if (id > 0) controller.fetchRequested(id, NOTHING);
   } else if (VoicemailContract.ACTION_SYNC_VOICEMAIL.equals(action)) {
    controller.syncRequested(NOTHING);
   } else if (ACTION_REQUEST_SENT.equals(action)) {
    String component = intent.getStringExtra(EXTRA_COMPONENT), account = intent.getStringExtra(EXTRA_ID);
    if (getResultCode() != Activity.RESULT_OK && component != null && account != null) controller.requestNotSent(component, account, NOTHING);
   }
  } catch (RuntimeException failed) { Log.w(TAG, "Voicemail request not handled: " + failed.getClass().getSimpleName()); }
 }
}

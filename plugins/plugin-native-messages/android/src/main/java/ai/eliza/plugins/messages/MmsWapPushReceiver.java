package ai.eliza.plugins.messages;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Telephony;

/**
 * WAP_PUSH_DELIVER (MMS notifications) for the default SMS app. A new M-Notification.ind starts one
 * download through SmsManager into a private file; {@link MmsResultReceiver} stores the retrieved
 * message. A notification whose transaction is already stored is not downloaded again, so a carrier's
 * repeat never creates a duplicate; it is answered with M-NotifyResp.ind (retrieved) once more, so the
 * carrier stops repeating it. Declared by the host behind BROADCAST_WAP_PUSH.
 */
public abstract class MmsWapPushReceiver extends BroadcastReceiver {
 protected abstract SmsRoleConfiguration configuration();
 static final String EXTRA_FILE = "eliza.mms.file", EXTRA_TRANSACTION = "eliza.mms.transaction", EXTRA_LOCATION = "eliza.mms.location", EXTRA_SUBSCRIPTION = "eliza.mms.subscription";

 @Override public void onReceive(Context context, Intent intent) {
  if (intent == null || !Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION.equals(intent.getAction()) || !"application/vnd.wap.mms-message".equals(intent.getType()) || !MmsStore.isDefaultSmsApp(context)) return;
  final byte[] pdu = intent.getByteArrayExtra("data");
  final int subscription = intent.getIntExtra(android.telephony.SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, intent.getIntExtra("subscription", -1));
  final SmsRoleConfiguration config = configuration();
  final Context app = context.getApplicationContext();
  final PendingResult pending = goAsync();
  try {
   SmsTelephony.WORK.execute(() -> {
    try { download(app, config, pdu, subscription); }
    catch (RuntimeException refused) { android.util.Log.e("MmsWapPushReceiver", "MMS notification not processed", refused); }
    finally { pending.finish(); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { pending.finish(); }
 }

 static void download(Context context, SmsRoleConfiguration config, byte[] pdu, int subscription) {
  MmsPdu.Message notice = MmsPdu.parse(pdu);
  // Delivery and read reports are not stored: MMS delivery is never claimed.
  if (notice.type != MmsPdu.NOTIFICATION_IND || notice.contentLocation == null || notice.transactionId == null) return;
  // Already stored (a carrier repeat, or an earlier download): answer "retrieved" again, never download twice.
  if (MmsStore.hasTransaction(context, notice.transactionId)) { MmsResultReceiver.respond(context, config, notice.transactionId, subscription); return; }
  String name = MmsStore.newFileName();
  Intent done = new Intent(config.mmsDownloadedAction).setClass(context, config.mmsResultReceiver).setPackage(context.getPackageName())
   .setData(Uri.fromParts("eliza-mms", name, null))
   .putExtra(EXTRA_FILE, name).putExtra(EXTRA_TRANSACTION, notice.transactionId).putExtra(EXTRA_LOCATION, notice.contentLocation).putExtra(EXTRA_SUBSCRIPTION, subscription);
  PendingIntent result = PendingIntent.getBroadcast(context, 0, done, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT);
  try {
   MmsStore.file(context, name);
   SmsTelephony.manager(context, subscription >= 0 ? subscription : android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId())
    .downloadMultimediaMessage(context, notice.contentLocation, MmsStore.fileUri(config, name), null, result);
  } catch (RuntimeException failed) {
   MmsStore.delete(context, name);
   throw failed;
  }
 }
}

package ai.eliza.plugins.messages;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import java.io.File;
import java.nio.file.Files;

/**
 * Results of the platform MMS service for the default SMS app: a finished download is parsed and
 * stored, then answered with M-NotifyResp.ind (retrieved); the answer's own result only removes its
 * file. A failed download stores nothing, and the carrier repeats the notification. Declared by the
 * host, not exported; explicit PendingIntents only.
 */
public abstract class MmsResultReceiver extends BroadcastReceiver {
 protected abstract SmsRoleConfiguration configuration();

 @Override public void onReceive(Context context, Intent intent) {
  if (intent == null) return;
  final SmsRoleConfiguration config = configuration();
  final String action = intent.getAction(), name = intent.getStringExtra(MmsWapPushReceiver.EXTRA_FILE);
  final boolean ok = getResultCode() == Activity.RESULT_OK;
  final Context app = context.getApplicationContext();
  if (config.mmsResponseSentAction.equals(action)) { MmsStore.delete(app, name); return; }
  if (!config.mmsDownloadedAction.equals(action) || !MmsStore.validFileName(name)) return;
  final String transaction = intent.getStringExtra(MmsWapPushReceiver.EXTRA_TRANSACTION), location = intent.getStringExtra(MmsWapPushReceiver.EXTRA_LOCATION);
  final int subscription = intent.getIntExtra(MmsWapPushReceiver.EXTRA_SUBSCRIPTION, -1);
  final PendingResult pending = goAsync();
  try {
   SmsTelephony.WORK.execute(() -> {
    try { if (ok && MmsStore.isDefaultSmsApp(app)) store(app, config, name, transaction, location, subscription); }
    catch (Exception failed) { android.util.Log.e("MmsResultReceiver", "Downloaded MMS not stored", failed); }
    finally { MmsStore.delete(app, name); pending.finish(); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { MmsStore.delete(app, name); pending.finish(); }
 }

 private static void store(Context context, SmsRoleConfiguration config, String name, String transaction, String location, int subscription) throws Exception {
  File file = MmsStore.file(context, name);
  if (!file.isFile() || file.length() > MmsPdu.MAX_PDU) throw new IllegalStateException("Downloaded MMS unavailable");
  MmsPdu.Message message = MmsPdu.parse(Files.readAllBytes(file.toPath()));
  if (message.type != MmsPdu.RETRIEVE_CONF) throw new IllegalStateException("Download was not a retrieved MMS");
  if (message.transactionId == null) message.transactionId = transaction;
  if (message.transactionId != null && MmsStore.hasTransaction(context, message.transactionId)) return;
  Uri row = MmsStore.persistIncomingMms(context, message, subscription, location);
  String text = MmsPdu.text(message);
  int attachments = MmsPdu.attachments(message).size();
  MmsStore.notifyIncoming(context, config, row, message.from, text.isEmpty() ? (attachments == 1 ? "1 attachment" : attachments + " attachments") : text);
  if (transaction != null) respond(context, config, transaction, subscription);
 }

 /** M-NotifyResp.ind (retrieved) for the notification's transaction, sent through the platform MMS service. */
 private static void respond(Context context, SmsRoleConfiguration config, String transaction, int subscription) {
  String name = MmsStore.newFileName();
  try {
   Files.write(MmsStore.file(context, name).toPath(), MmsPdu.encodeNotifyResponse(transaction, MmsPdu.STATUS_RETRIEVED));
   Intent sent = new Intent(config.mmsResponseSentAction).setClass(context, config.mmsResultReceiver).setPackage(context.getPackageName())
    .setData(Uri.fromParts("eliza-mms", name, null)).putExtra(MmsWapPushReceiver.EXTRA_FILE, name);
   PendingIntent result = PendingIntent.getBroadcast(context, 0, sent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT);
   SmsTelephony.manager(context, subscription >= 0 ? subscription : android.telephony.SubscriptionManager.getDefaultSmsSubscriptionId())
    .sendMultimediaMessage(context, MmsStore.fileUri(config, name), null, null, result);
  } catch (Exception failed) {
   // The message is stored; without the response the carrier may notify again, which is deduplicated.
   MmsStore.delete(context, name);
  }
 }
}

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
 * file. A failed download stores nothing, and the carrier repeats the notification. It also takes the
 * "Mark as read" action of a new-message notification. Declared by the host, not exported; explicit
 * PendingIntents only.
 */
public abstract class MmsResultReceiver extends BroadcastReceiver {
 static final String ACTION_MARK_READ = "ai.eliza.plugins.messages.action.MARK_THREAD_READ";
 static final String EXTRA_THREAD = "thread", EXTRA_THROUGH = "through";
 static final String EXTRA_NOTICE = "notice";
 protected abstract SmsRoleConfiguration configuration();

 /** Marks the notified conversation read up to the notified message, as the default SMS app. */
 private void markRead(Context app, SmsRoleConfiguration config, Intent intent) {
  final long thread = intent.getLongExtra(EXTRA_THREAD, 0), through = intent.getLongExtra(EXTRA_THROUGH, 0);
  final String notice = intent.getStringExtra(EXTRA_NOTICE);
  if (thread <= 0 || through <= 0 || notice == null) return;
  final PendingResult pending = goAsync();
  try {
   SmsTelephony.WORK.execute(() -> {
    try {
     // Incoming publication uses this same worker. A replaced notice cannot grant a later read.
     if (!MmsStore.ownsNotice(app, config, thread, notice)) return;
     if (MmsStore.isDefaultSmsApp(app)) MmsStore.markThreadRead(app, thread, through);
     // Android ignores the write from any other app; the messages stay unread and only the notice goes.
     else MmsStore.cancelThreadNotice(app, thread);
    } catch (RuntimeException failed) { android.util.Log.e("MmsResultReceiver", "Conversation not marked read", failed); }
    finally { pending.finish(); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { pending.finish(); }
 }

 @Override public void onReceive(Context context, Intent intent) {
  if (intent == null) return;
  final SmsRoleConfiguration config = configuration();
  final String action = intent.getAction(), name = intent.getStringExtra(MmsWapPushReceiver.EXTRA_FILE);
  final boolean ok = getResultCode() == Activity.RESULT_OK;
  final Context app = context.getApplicationContext();
  if (ACTION_MARK_READ.equals(action)) { markRead(app, config, intent); return; }
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
  try { MmsStore.notifyIncoming(context, config, row, message.from, text.isEmpty() ? (attachments == 1 ? "1 attachment" : attachments + " attachments") : text); }
  catch (RuntimeException unconfirmed) { android.util.Log.e("MmsResultReceiver", "Incoming MMS stored; notice publication unconfirmed", unconfirmed); }
  if (transaction != null) respond(context, config, transaction, subscription);
 }

 /**
  * M-NotifyResp.ind (retrieved) for the notification's transaction, sent through the platform MMS
  * service. Also the answer to a repeated notification of a message already stored, so a carrier that
  * missed the first answer stops notifying.
  */
 static void respond(Context context, SmsRoleConfiguration config, String transaction, int subscription) {
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

package ai.eliza.plugins.messages;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsMessage;

/**
 * SMS_DELIVER for the default SMS app. Android delivers each incoming text only to the role holder,
 * which must store it, so the message is persisted whenever this app holds the role; the notice
 * follows. Declared by the host behind BROADCAST_SMS.
 */
public abstract class SmsDeliverReceiver extends BroadcastReceiver {
 protected abstract SmsRoleConfiguration configuration();

 @Override public void onReceive(Context context, Intent intent) {
  if (intent == null || !Telephony.Sms.Intents.SMS_DELIVER_ACTION.equals(intent.getAction()) || !MmsStore.isDefaultSmsApp(context)) return;
  SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
  if (messages == null || messages.length == 0) return;
  String sender = null; long timestamp = 0; StringBuilder body = new StringBuilder();
  for (SmsMessage message : messages) {
   if (message == null) continue;
   if (sender == null) sender = message.getDisplayOriginatingAddress();
   if (timestamp == 0) timestamp = message.getTimestampMillis();
   if (message.getDisplayMessageBody() != null) body.append(message.getDisplayMessageBody());
  }
  int subscription = intent.getIntExtra(android.telephony.SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, -1);
  final SmsRoleConfiguration config = configuration();
  final Context app = context.getApplicationContext();
  final String from = sender, text = body.toString(); final long at = timestamp;
  final PendingResult pending = goAsync();
  try {
   SmsTelephony.WORK.execute(() -> {
    try {
     Uri row = MmsStore.persistIncomingSms(app, from, text, at, subscription);
     MmsStore.notifyIncoming(app, config, row, from, text);
    } catch (RuntimeException refused) {
     android.util.Log.e("SmsDeliverReceiver", "Incoming SMS could not be stored", refused);
    } finally { pending.finish(); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { pending.finish(); }
 }
}

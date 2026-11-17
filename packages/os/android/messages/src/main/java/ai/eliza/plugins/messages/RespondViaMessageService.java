package ai.eliza.plugins.messages;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import android.telephony.TelephonyManager;

/**
 * RESPOND_VIA_MESSAGE for the default SMS app. A quick reply chosen in another app's call screen is
 * never sent from here: the reply opens the host's compose review ({@link SmsComposeActivity}) from a
 * notice, and only the owner's Send there sends it. Declared by the host behind
 * SEND_RESPOND_VIA_MESSAGE.
 */
public abstract class RespondViaMessageService extends Service {
 protected abstract SmsRoleConfiguration configuration();
 @Override public IBinder onBind(Intent intent) { return null; }

 @Override public int onStartCommand(Intent intent, int flags, int startId) {
  try {
   if (intent != null && TelephonyManager.ACTION_RESPOND_VIA_MESSAGE.equals(intent.getAction())) {
    SmsRoleConfiguration config = configuration();
    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
    if (text == null) text = intent.getStringExtra("sms_body");
    Uri data = intent.getData();
    Intent review = new Intent(this, config.composeActivity).setAction(Intent.ACTION_SENDTO).setData(data).putExtra("sms_body", text == null ? "" : text).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    PendingIntent open = PendingIntent.getActivity(this, 0, review, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    NotificationManager notifications = getSystemService(NotificationManager.class);
    if (notifications != null) {
     notifications.createNotificationChannel(new NotificationChannel(config.channelId, config.channelName, NotificationManager.IMPORTANCE_HIGH));
     notifications.notify("respond-via-message", 1, new Notification.Builder(this, config.channelId).setSmallIcon(config.notificationIcon)
      .setContentTitle("Review your reply").setContentText("Nothing is sent until you press Send.").setAutoCancel(true).setContentIntent(open)
      .setVisibility(Notification.VISIBILITY_PRIVATE).build());
    }
   }
  } catch (RuntimeException unavailable) {
   android.util.Log.w("RespondViaMessage", "Quick reply review could not be offered", unavailable);
  } finally { stopSelf(startId); }
  return START_NOT_STICKY;
 }
}

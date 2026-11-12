package ai.eliza.plugins.messages;

import android.app.Activity;
import android.content.BroadcastReceiver;

/**
 * Host identity of the default-SMS-app components. A host that can hold the SMS role declares thin
 * subclasses of {@link SmsDeliverReceiver}, {@link MmsWapPushReceiver}, {@link MmsResultReceiver},
 * {@link RespondViaMessageService} and {@link SmsComposeActivity}, plus {@link MmsFileProvider} under
 * {@link #mmsFileAuthority}. The channel ID, actions and authority are installed identity.
 */
public final class SmsRoleConfiguration {
 public final SmsTelephonyConfiguration telephony;
 public final String channelId, channelName, mmsDownloadedAction, mmsResponseSentAction, mmsFileAuthority;
 public final int notificationIcon;
 public final Class<? extends BroadcastReceiver> mmsResultReceiver;
 public final Class<? extends Activity> composeActivity, openActivity;

 /**
  * @param openActivity what a new-message notification opens (for example the host's main activity).
  * @param composeActivity the host's {@link SmsComposeActivity} subclass, which reviews every send.
  */
 public SmsRoleConfiguration(SmsTelephonyConfiguration telephony, String channelId, String channelName, int notificationIcon,
   String mmsDownloadedAction, String mmsResponseSentAction, String mmsFileAuthority,
   Class<? extends BroadcastReceiver> mmsResultReceiver, Class<? extends Activity> composeActivity, Class<? extends Activity> openActivity) {
  this.telephony = java.util.Objects.requireNonNull(telephony);
  if (channelId == null || !channelId.matches("[A-Za-z0-9_.-]{1,64}") || channelName == null || channelName.trim().isEmpty() || channelName.length() > 64
    || mmsDownloadedAction == null || !mmsDownloadedAction.matches("[A-Za-z0-9_.]{1,200}") || mmsResponseSentAction == null || !mmsResponseSentAction.matches("[A-Za-z0-9_.]{1,200}")
    || mmsDownloadedAction.equals(mmsResponseSentAction) || mmsFileAuthority == null || !mmsFileAuthority.matches("[A-Za-z0-9_.-]{1,200}"))
   throw new IllegalArgumentException("Invalid SMS role configuration");
  this.channelId = channelId; this.channelName = channelName; this.notificationIcon = notificationIcon;
  this.mmsDownloadedAction = mmsDownloadedAction; this.mmsResponseSentAction = mmsResponseSentAction; this.mmsFileAuthority = mmsFileAuthority;
  this.mmsResultReceiver = java.util.Objects.requireNonNull(mmsResultReceiver);
  this.composeActivity = java.util.Objects.requireNonNull(composeActivity);
  this.openActivity = java.util.Objects.requireNonNull(openActivity);
 }
}

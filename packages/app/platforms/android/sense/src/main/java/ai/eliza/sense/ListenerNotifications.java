package ai.eliza.sense;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.provider.Settings;

/**
 * The listening indicator the listener itself owns: an ongoing foreground-service notification,
 * public on the lock screen (status text only, never content), with Pause and Stop usable without
 * unlocking and Resume requiring authentication. The system microphone privacy indicator is
 * separate and is not controlled here. Attention states (before unlock, revoked permission,
 * stopped after errors, no speech model) get a quiet non-ongoing status notification.
 */
final class ListenerNotifications {
 private ListenerNotifications(){}
 /**
  * The indicator channel is DEFAULT importance without sound or vibration: LOW counts as a silent
  * notification, which the lock screen hides when "hide silent notifications" is on. Channel
  * importance cannot be raised after creation, so the earlier LOW "listening" channel is replaced.
  */
 static final String CHANNEL_ACTIVE="listening-indicator",CHANNEL_STATUS="listener-status",CHANNEL_RETIRED="listening";
 static final int ACTIVE_ID=1,STATUS_ID=2;

 static void channels(Context context){
  NotificationManager manager=context.getSystemService(NotificationManager.class);
  manager.deleteNotificationChannel(CHANNEL_RETIRED);
  NotificationChannel active=new NotificationChannel(CHANNEL_ACTIVE,"Always-on listening",NotificationManager.IMPORTANCE_DEFAULT);
  active.setDescription("Shown whenever always-on listening is on or paused. Blocking it turns listening off.");
  active.setSound(null,null);
  active.enableVibration(false);
  active.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
  active.setShowBadge(false);
  NotificationChannel status=new NotificationChannel(CHANNEL_STATUS,"Listening status",NotificationManager.IMPORTANCE_LOW);
  status.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
  status.setShowBadge(false);
  manager.createNotificationChannel(active);
  manager.createNotificationChannel(status);
 }

 private static PendingIntent action(Context context,String action,int code){
  Intent intent=new Intent().setComponent(SenseConfig.component(context,"ListenerActionReceiver")).setAction(action);
  return PendingIntent.getBroadcast(context,code,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
 }

 private static PendingIntent settings(Context context){
  Intent intent=new Intent().setComponent(SenseConfig.component(context,"ConsentActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  return PendingIntent.getActivity(context,10,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
 }

 private static Notification.Action button(Context context,String label,String action,int code,boolean needsUnlock){
  Notification.Action.Builder button=new Notification.Action.Builder(Icon.createWithResource(context,R.drawable.ic_listening),label,action(context,action,code))
   .setAuthenticationRequired(needsUnlock);
  String marker=ListenerActionContract.marker(action);
  if(marker!=null){android.os.Bundle extras=new android.os.Bundle();extras.putString(ListenerActionContract.KEY,marker);button.addExtras(extras);}
  return button.build();
 }

 static Notification active(Context context,ListenerPolicy.State state){
  channels(context);
  Notification.Builder builder=new Notification.Builder(context,CHANNEL_ACTIVE)
   .setSmallIcon(R.drawable.ic_listening)
   .setContentTitle(ListenerPolicy.label(state))
   .setContentText(ListenerPolicy.processesAudio(state)?"Say “"+BuildConfig.SENSE_WAKE_LABEL+"” to ask. Audio stays on this phone and is not saved."
    :state==ListenerPolicy.State.PAUSED_DISPLAY_OFF?"Turn on Always-on display to keep listening with the screen off. Listening resumes when the indicator shows."
    :state==ListenerPolicy.State.PAUSED_FULLSCREEN?"The Listening indicator is hidden by a fullscreen app. Listening resumes when the status bar shows again."
    :state==ListenerPolicy.State.PAUSED_SHADE?"Listening resumes when the notification shade closes."
    :state==ListenerPolicy.State.PAUSED_TRANSITION?"Listening resumes when the Listening indicator shows."
    :"The microphone is not being analysed.")
   .setCategory(Notification.CATEGORY_SERVICE)
   .setVisibility(Notification.VISIBILITY_PUBLIC)
   .setOngoing(true)
   .setOnlyAlertOnce(true)
   .setShowWhen(false)
   .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
   .setContentIntent(settings(context))
   .setDeleteIntent(action(context,ListenerActionReceiver.DISMISSED,4));
  if(state==ListenerPolicy.State.PAUSED_USER)builder.addAction(button(context,"Resume",ListenerActionReceiver.RESUME,3,ListenerPolicy.resumeRequiresUnlock()));
  else builder.addAction(button(context,"Pause",ListenerActionReceiver.PAUSE,1,false));
  builder.addAction(button(context,"Turn off",ListenerActionReceiver.STOP,2,false));
  return builder.build();
 }

 /**
  * Whether the listening indicator would be visible in the shade and on the lock screen (including
  * the device-wide lock-screen notification setting). Creates
  * the channels first so a fresh install is judged on the channel it will post to.
  */
 static boolean indicatorVisible(Context context){
  NotificationManager manager=context.getSystemService(NotificationManager.class);
  if(manager==null)return false;
  try{
   channels(context);
   NotificationChannel channel=manager.getNotificationChannel(CHANNEL_ACTIVE);
   return ListenerPolicy.notificationsVisible(context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED,
    manager.areNotificationsEnabled(),channel==null?NotificationManager.IMPORTANCE_NONE:channel.getImportance(),
    channel!=null&&channel.getLockscreenVisibility()==Notification.VISIBILITY_SECRET,lockScreenShowsNotifications(context));
  }catch(RuntimeException unavailable){return false;}
 }

 /** AOSP Settings action for the lock-screen page, which holds Always-on display. */
 static final String LOCK_SCREEN_SETTINGS="android.settings.LOCK_SCREEN_SETTINGS";
 /** Settings.Secure.DOZE_ALWAYS_ON (hidden constant). Unreadable or unset counts as off; SystemUI's report decides capture. */
 static final String DOZE_ALWAYS_ON="doze_always_on";

 static boolean alwaysOnDisplayEnabled(Context context){
  try{return Settings.Secure.getInt(context.getContentResolver(),DOZE_ALWAYS_ON,0)!=0;}
  catch(RuntimeException unreadable){return false;}
 }

 /** Settings.Secure.LOCK_SCREEN_SHOW_NOTIFICATIONS (hidden constant; default on). Unreadable counts as hidden. */
 static final String LOCK_SCREEN_SHOW_NOTIFICATIONS="lock_screen_show_notifications";

 static boolean lockScreenShowsNotifications(Context context){
  try{return Settings.Secure.getInt(context.getContentResolver(),LOCK_SCREEN_SHOW_NOTIFICATIONS,1)!=0;}
  catch(RuntimeException unreadable){return false;}
 }

 /** Posts or clears the attention notification for states that capture nothing. */
 static void showStatus(Context context,ListenerPolicy.State state){
  NotificationManager manager=context.getSystemService(NotificationManager.class);
  if(manager==null)return;
  if(!ListenerPolicy.needsAttention(state)){manager.cancel(STATUS_ID);return;}
  channels(context);
  Notification.Builder builder=new Notification.Builder(context,CHANNEL_STATUS)
   .setSmallIcon(R.drawable.ic_listening)
   .setContentTitle(ListenerPolicy.label(state))
   .setContentText(state==ListenerPolicy.State.NOTIFICATIONS_REQUIRED?"Listening is off until its notification is allowed. Open listening settings."
    :state==ListenerPolicy.State.WAITING_FOR_UNLOCK?"The microphone stays off until you unlock this phone."
    :state==ListenerPolicy.State.INDICATOR_UNAVAILABLE?"The microphone stays off until the system Listening indicator can be shown."
    :state==ListenerPolicy.State.STOPPED_INDICATOR_LOST?"The system Listening indicator was not shown, so the microphone was turned off. Open listening settings to resume.":"The microphone is off. Open listening settings to turn it back on.")
   .setVisibility(Notification.VISIBILITY_PUBLIC)
   .setOnlyAlertOnce(true)
   .setContentIntent(settings(context));
  try{manager.notify(STATUS_ID,builder.build());}catch(SecurityException notificationsDenied){}
 }
}

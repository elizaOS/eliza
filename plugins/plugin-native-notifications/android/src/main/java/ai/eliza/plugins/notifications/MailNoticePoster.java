package ai.eliza.plugins.notifications;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import java.util.Objects;

/**
 * Content-free new-mail notices for {@link MailBackgroundDelivery}. A notice names no sender, subject or body;
 * its tap and its authenticated Ask action open the host activity with only an opaque ledger key, which the
 * host hands to {@link MailBackgroundDelivery#capture}. Private on the lock screen, with a redacted public
 * version.
 */
public final class MailNoticePoster implements MailBackgroundDelivery.Notices {
 /** Immutable host inputs. Channel ID, action, prefixes and tag are migration-sensitive. */
 public static final class Config {
  public final String channel,action,openPrefix,askPrefix,tagPrefix;
  final String channelName,channelDescription,title,text,publicTitle,publicText,askLabel;final int smallIcon;final Class<? extends Activity> activity;
  /**
   * @param activity the host activity a tap opens; null opens the package's launch activity
   */
  public Config(String channel,String channelName,String channelDescription,String action,String openPrefix,String askPrefix,String tagPrefix,int smallIcon,String title,String text,String publicTitle,String publicText,String askLabel,Class<? extends Activity> activity){
   for(String value:new String[]{channel,channelName,channelDescription,action,openPrefix,askPrefix,tagPrefix,title,text,publicTitle,publicText,askLabel})if(value==null||value.isBlank())throw new IllegalArgumentException("Invalid mail notice configuration");
   if(openPrefix.startsWith(askPrefix)||askPrefix.startsWith(openPrefix)||smallIcon==0)throw new IllegalArgumentException("Invalid mail notice configuration");
   this.channel=channel;this.channelName=channelName;this.channelDescription=channelDescription;this.action=action;this.openPrefix=openPrefix;this.askPrefix=askPrefix;this.tagPrefix=tagPrefix;this.smallIcon=smallIcon;this.title=title;this.text=text;this.publicTitle=publicTitle;this.publicText=publicText;this.askLabel=askLabel;this.activity=activity;
  }
 }
 /** A tap on one of these notices: the ledger key and whether it was the Ask action. */
 public static final class Tap {public final String key;public final boolean question;Tap(String key,boolean question){this.key=key;this.question=question;}}
 private static final long LIFETIME_MS=86400000L;
 private final Context context;private final NotificationManager manager;private final Config config;
 public MailNoticePoster(Context context,Config config){
  this.context=context.getApplicationContext();this.config=Objects.requireNonNull(config);manager=this.context.getSystemService(NotificationManager.class);
  NotificationChannel channel=new NotificationChannel(config.channel,config.channelName,NotificationManager.IMPORTANCE_DEFAULT);channel.setDescription(config.channelDescription);channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);manager.createNotificationChannel(channel);
 }
 /** The tap an intent carries, or null for any other intent. */
 public Tap tap(Intent intent){
  if(intent==null||!config.action.equals(intent.getAction())||intent.getData()==null)return null;
  String uri=intent.getData().toString();boolean question=uri.startsWith(config.askPrefix);
  if(!question&&!uri.startsWith(config.openPrefix))return null;
  return new Tap(uri.substring((question?config.askPrefix:config.openPrefix).length()),question);
 }
 @Override public boolean allowed(){NotificationChannel c=manager.getNotificationChannel(config.channel);return (Build.VERSION.SDK_INT<33||context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)&&manager.areNotificationsEnabled()&&c!=null&&c.getImportance()!=NotificationManager.IMPORTANCE_NONE;}
 @Override public boolean active(String key){for(StatusBarNotification n:manager.getActiveNotifications())if((config.tagPrefix+key).equals(n.getTag()))return true;return false;}
 private Intent intent(String key,boolean question){
  Intent launch=config.activity!=null?new Intent(context,config.activity):context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
  if(launch==null)throw new IllegalStateException("Mail notice route unavailable");
  return launch.setAction(config.action).setData(Uri.parse((question?config.askPrefix:config.openPrefix)+key)).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
 }
 @Override public void post(String key){
  PendingIntent tap=PendingIntent.getActivity(context,0,intent(key,false),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
  PendingIntent askTap=PendingIntent.getActivity(context,0,intent(key,true),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
  Notification.Action.Builder ask=new Notification.Action.Builder(null,config.askLabel,askTap);if(Build.VERSION.SDK_INT>=31)ask.setAuthenticationRequired(true);
  Notification redacted=new Notification.Builder(context,config.channel).setSmallIcon(config.smallIcon).setContentTitle(config.publicTitle).setContentText(config.publicText).build();
  manager.notify(config.tagPrefix+key,0,new Notification.Builder(context,config.channel).setSmallIcon(config.smallIcon).setContentTitle(config.title).setContentText(config.text).setPublicVersion(redacted).setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(tap).addAction(ask.build()).setOnlyAlertOnce(true).setAutoCancel(true).setTimeoutAfter(LIFETIME_MS).setCategory(Notification.CATEGORY_EMAIL).build());
  // A bounded observation distinguishes posted from uncertain; the caller never replays an uncertain post.
  long until=SystemClock.elapsedRealtime()+500;
  while(!active(key)&&SystemClock.elapsedRealtime()<until){try{Thread.sleep(25);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();break;}}
 }
 @Override public void cancel(String key){
  manager.cancel(config.tagPrefix+key,0);
  for(boolean question:new boolean[]{false,true}){PendingIntent pending;try{pending=PendingIntent.getActivity(context,0,intent(key,question),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_NO_CREATE);}catch(IllegalStateException unavailable){continue;}if(pending!=null)pending.cancel();}
 }
 @Override public void cancelAll(){for(StatusBarNotification n:manager.getActiveNotifications())if(n.getTag()!=null&&n.getTag().startsWith(config.tagPrefix))cancel(n.getTag().substring(config.tagPrefix.length()));}
}

package ai.eliza.plugins.notifications;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
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

/** NoticeDelivery poster for the host's own step and approval notices. It uses only the host's channels;
 * private contents are hidden on the lock screen and only pending approvals use a high-importance channel.
 * A notice's tap and its Ask action open the host's launch activity with an opaque route token; neither
 * carries a decision, RemoteInput or send. */
public class HostNoticePoster implements NoticeDelivery.Poster {
 /** Looks up the route token prepared for a notice ID (see NoticeRoutes.token). */
 public interface Routes {String token(String id)throws Exception;}
 /** Immutable host inputs. Channel IDs, tag prefix, actions and route prefix are migration-sensitive. */
 public static final class Config {
  final String stepChannel,stepChannelName,stepChannelDescription,approvalChannel,approvalChannelName,approvalChannelDescription;
  final String tagPrefix,openAction,askAction,routePrefix,stepPublicTitle,approvalPublicTitle,lockedText,askLabel,quietGroup;
  final int smallIcon;final long stepTimeoutMs;
  public Config(String stepChannel,String stepChannelName,String stepChannelDescription,String approvalChannel,String approvalChannelName,String approvalChannelDescription,int smallIcon,String tagPrefix,String openAction,String askAction,String routePrefix,String stepPublicTitle,String approvalPublicTitle,String lockedText,String askLabel,String quietGroup,long stepTimeoutMs){
   for(String value:new String[]{stepChannel,stepChannelName,stepChannelDescription,approvalChannel,approvalChannelName,approvalChannelDescription,tagPrefix,openAction,askAction,routePrefix,stepPublicTitle,approvalPublicTitle,lockedText,askLabel,quietGroup})if(value==null||value.isBlank())throw new IllegalArgumentException("Invalid notice poster configuration");
   if(stepChannel.equals(approvalChannel)||openAction.equals(askAction)||smallIcon==0||stepTimeoutMs<=0)throw new IllegalArgumentException("Invalid notice poster configuration");
   this.stepChannel=stepChannel;this.stepChannelName=stepChannelName;this.stepChannelDescription=stepChannelDescription;this.approvalChannel=approvalChannel;this.approvalChannelName=approvalChannelName;this.approvalChannelDescription=approvalChannelDescription;
   this.smallIcon=smallIcon;this.tagPrefix=tagPrefix;this.openAction=openAction;this.askAction=askAction;this.routePrefix=routePrefix;this.stepPublicTitle=stepPublicTitle;this.approvalPublicTitle=approvalPublicTitle;this.lockedText=lockedText;this.askLabel=askLabel;this.quietGroup=quietGroup;this.stepTimeoutMs=stepTimeoutMs;
  }
 }
 private final Context context;private final Config config;private final Routes routes;
 public HostNoticePoster(Context context,Config config,Routes routes){
  this.context=context.getApplicationContext();this.config=Objects.requireNonNull(config);this.routes=Objects.requireNonNull(routes);
  NotificationChannel channel=new NotificationChannel(config.stepChannel,config.stepChannelName,NotificationManager.IMPORTANCE_DEFAULT);channel.setDescription(config.stepChannelDescription);channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);manager().createNotificationChannel(channel);
  NotificationChannel approvals=new NotificationChannel(config.approvalChannel,config.approvalChannelName,NotificationManager.IMPORTANCE_HIGH);approvals.setDescription(config.approvalChannelDescription);approvals.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);manager().createNotificationChannel(approvals);
 }
 private NotificationManager manager(){return context.getSystemService(NotificationManager.class);}
 private String tag(String id){return config.tagPrefix+id;}
 private String channelFor(String id){return NoticeDelivery.approvalId(id)?config.approvalChannel:config.stepChannel;}
 private boolean allowed(String name){
  if(Build.VERSION.SDK_INT>=33&&context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return false;
  NotificationChannel channel=manager().getNotificationChannel(name);if(!manager().areNotificationsEnabled()||channel==null||channel.getImportance()==NotificationManager.IMPORTANCE_NONE)return false;
  NotificationChannelGroup group=channel.getGroup()==null?null:manager().getNotificationChannelGroup(channel.getGroup());return group==null||!group.isBlocked();
 }
 @Override public boolean allowed(){return allowed(config.stepChannel);}
 @Override public boolean approvalsAllowed(){return allowed(config.approvalChannel);}
 private Intent launch(String action,String token){
  Intent launch=context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
  if(launch==null||token==null)throw new IllegalStateException("Notice route unavailable");
  return launch.setAction(action).setData(Uri.parse(config.routePrefix+token));
 }
 private PendingIntent tap(String id,boolean question)throws Exception{
  return PendingIntent.getActivity(context,0,launch(question?config.askAction:config.openAction,routes.token(id)),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
 }
 private Notification redacted(String channel,String title){return new Notification.Builder(context,channel).setSmallIcon(config.smallIcon).setContentTitle(title).setContentText(config.lockedText).build();}
 /** Visible for builder tests. An unopened step notice times out; opening it cancels it. */
 public Notification.Builder step(String title,String body,PendingIntent tap){
  return new Notification.Builder(context,config.stepChannel).setSmallIcon(config.smallIcon).setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(redacted(config.stepChannel,config.stepPublicTitle)).setOnlyAlertOnce(true).setAutoCancel(false).setTimeoutAfter(config.stepTimeoutMs).setCategory(Notification.CATEGORY_STATUS).setContentIntent(tap);
 }
 /** Visible for builder tests. Redacted approval request that disappears when the approval expires; tapping only opens the run. */
 public Notification.Builder approval(String title,String body,long timeoutMs,PendingIntent tap){
  if(timeoutMs<=0)throw new IllegalArgumentException("Approval already expired");
  return new Notification.Builder(context,config.approvalChannel).setSmallIcon(config.smallIcon).setContentTitle(title).setContentText(body).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(redacted(config.approvalChannel,config.approvalPublicTitle)).setOnlyAlertOnce(true).setAutoCancel(false).setTimeoutAfter(timeoutMs).setCategory(Notification.CATEGORY_REMINDER).setContentIntent(tap);
 }
 /** Ask only opens a reviewed draft; there is no RemoteInput, send or decision action. */
 public Notification.Action question(PendingIntent tap){
  Notification.Action.Builder ask=new Notification.Action.Builder(null,config.askLabel,tap);
  if(Build.VERSION.SDK_INT>=31)ask.setAuthenticationRequired(true);
  return ask.build();
 }
 @Override public void post(String id,String title,String body)throws Exception{
  if(!allowed())throw new SecurityException("Notification delivery is disabled");
  manager().notify(tag(id),0,step(title,body,tap(id,false)).addAction(question(tap(id,true))).build());awaitListed(id);
 }
 /** notify() hands the notice to the system asynchronously, so an immediate read of the active list
  * can miss it and the receipt would record "unknown" for a notice Android is about to show. Wait
  * briefly (callers are never on the main thread); a notice still missing afterwards stays "unknown". */
 private void awaitListed(String id){
  long end=SystemClock.elapsedRealtime()+2000;
  while(SystemClock.elapsedRealtime()<end){
   for(StatusBarNotification row:manager().getActiveNotifications())if(row.getId()==0&&tag(id).equals(row.getTag()))return;
   try{Thread.sleep(20);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
  }
 }
 @Override public void postApproval(String id,String title,String body,long timeoutMs)throws Exception{
  if(!NoticeDelivery.approvalId(id)||!approvalsAllowed())throw new SecurityException("Approval notifications are disabled");
  manager().notify(tag(id),0,approval(title,body,timeoutMs,tap(id,false)).addAction(question(tap(id,true))).build());awaitListed(id);
 }
 @Override public void postApprovalQuiet(String id,String title,String body,long timeoutMs)throws Exception{
  if(!NoticeDelivery.approvalId(id)||!approvalsAllowed())throw new SecurityException("Approval notifications are disabled");
  // Group children with SUMMARY-only alert behavior cannot sound/vibrate, even on the high channel.
  manager().notify(tag(id),0,approval(title,body,timeoutMs,tap(id,false)).addAction(question(tap(id,true))).setGroup(config.quietGroup).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY).build());awaitListed(id);
 }
 @Override public void cancel(String id){
  manager().cancel(tag(id),0);
  try{String token=routes.token(id);if(token!=null&&context.getPackageManager().getLaunchIntentForPackage(context.getPackageName())!=null)for(String action:new String[]{config.openAction,config.askAction}){
   // Intent.filterEquals distinguishes actions, so the notice's Ask PendingIntent is revoked separately.
   PendingIntent pending=PendingIntent.getActivity(context,0,launch(action,token),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_NO_CREATE);if(pending!=null)pending.cancel();
  }}catch(Exception failure){throw new IllegalStateException("Stale notice tap could not be invalidated",failure);}
 }
 @Override public boolean matches(String id,String title,String body){for(StatusBarNotification row:manager().getActiveNotifications())if(row.getId()==0&&tag(id).equals(row.getTag())){Notification notice=row.getNotification();return channelFor(id).equals(notice.getChannelId())&&title.contentEquals(notice.extras.getCharSequence(Notification.EXTRA_TITLE,""))&&body.contentEquals(notice.extras.getCharSequence(Notification.EXTRA_BIG_TEXT,notice.extras.getCharSequence(Notification.EXTRA_TEXT,"")));}return false;}
}

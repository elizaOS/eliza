package ai.eliza.plugins.notifications;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Capacitor bridge for a phone host's notifications: its own notices, Android's delivery
 * settings, the optional cross-app {@link NotificationMirror} and workflow notices with their tap
 * routes ({@link NoticeDelivery}, {@link NoticeRoutes}, {@link NoticeTapInbox}).
 *
 * <p>Hosts subclass this with their own {@code @CapacitorPlugin(name=...)} (the annotation is not
 * inherited) and supply only installed identities: product label and scope, the durable credential
 * slots behind {@link #noticeStorage()}, and the ledger, route and poster configurations. Those
 * values are migration-sensitive; a host keeps the ones it already deployed.
 *
 * <p>Semantics every host gets:
 * <ul>
 * <li>Durable notice work (receipts, routes, question excerpts) runs on one bounded worker and only
 *   behind {@link ForegroundNoticeGate}: focused, unlocked, not finishing, not destroyed.</li>
 * <li>{@code postWorkflow} answers with the ledger's status. It never reports {@code posted} for a
 *   notice that was only recorded, and an uncertain dispatch is never repeated.</li>
 * <li>A question excerpt is attached only while unlocked and only from the exact, still-posted own
 *   notice on its expected channel; a secret notice yields none.</li>
 * <li>Rows hide title and text while locked or secret. Identifiers are opaque and forgotten on pause.</li>
 * </ul>
 */
public abstract class NotificationsHostPlugin extends Plugin {
 /** Renderer event: a workflow notice tap was captured or settled; read {@code pendingWorkflowTap}. */
 public static final String PENDING_WORKFLOW_TAP_EVENT="pendingWorkflowTap";
 /** Bound on rows returned by {@code list} and items accepted by {@code clear}. */
 public static final int MAX_ROWS=100;
 /** One worker per process: notice storage writes keep one order across plugin instances. */
 private static final NoticeWorker NOTICE_IO=new NoticeWorker();

 /** The product label shown on own rows, e.g. the app name. */
 protected abstract String appLabel();
 /** The scope string reported with status and list results. */
 protected abstract String scope();
 /** Durable, committed-before-return storage for the notice ledger and routes (host credential slots). */
 protected abstract NoticeDelivery.Storage noticeStorage();
 /** The deployed ledger slots, redacted approval copy and approval bound. */
 protected abstract NoticeDelivery.Config deliveryConfig();
 /** The deployed route slots and identifier fields. */
 protected abstract NoticeRoutes.Config routesConfig();
 /** The deployed channels, icon, tag prefix and launch actions. */
 protected abstract HostNoticePoster.Config posterConfig();
 /** The host's cross-app mirror, or null when the host offers no notification access. */
 protected NotificationMirror mirror(){return null;}
 /**
  * The kind of one of the host's own notices, from its channel. The default recognizes the
  * workflow channels; hosts add their own (reminders, navigation, results). Unknown is "other".
  */
 protected String noticeKind(String channel){
  HostNoticePoster.Config poster=posterConfig();
  if(channel!=null&&(channel.equals(poster.stepChannel)||channel.equals(poster.approvalChannel)))return "workflow";
  return "other";
 }
 /** The route ledger; hosts may return their own subclass with the same configuration. */
 protected NoticeRoutes routes(){return new NoticeRoutes(noticeStorage(),routesConfig());}
 /** The poster for workflow notices on the host's channels. */
 protected HostNoticePoster poster(){NoticeRoutes routes=routes();return new HostNoticePoster(getContext(),posterConfig(),routes::token);}
 protected NoticeDelivery delivery(){return new NoticeDelivery(deliveryConfig(),noticeStorage(),poster());}

 private final Handler noticeMain=new Handler(Looper.getMainLooper());
 private final ForegroundNoticeGate noticeGate=new ForegroundNoticeGate(new ForegroundNoticeGate.MainThread(){
  public boolean isCurrent(){return Looper.myLooper()==Looper.getMainLooper();}
  public boolean post(Runnable check){return noticeMain.post(check);}
  public void remove(Runnable check){noticeMain.removeCallbacks(check);}
 },this::foreground,NOTICE_IO);
 /** Notice work admitted by the foreground gate. */
 protected interface NoticeWork {void run()throws Exception;}
 /** Runs work on the notice worker behind the foreground gate; any refusal rejects call with failure. */
 protected final void noticeWork(PluginCall call,String failure,NoticeWork work){noticeGate.submit(failure,call::reject,work::run);}
 /** Off main only: throws unless the host is in the foreground now. Call again after a blocking read. */
 protected final void requireNoticeForeground()throws Exception{noticeGate.require();}
 protected final boolean noticeHostDestroyed(){return noticeGate.destroyed();}
 protected final Handler noticeMain(){return noticeMain;}
 /** Main thread: throws unless the activity is focused, not finishing and the device is unlocked. */
 protected void foreground(){Activity activity=getActivity();if(activity==null||activity.isFinishing()||!activity.hasWindowFocus()||locked())throw new IllegalStateException();}
 protected final NotificationManager manager(){return getContext().getSystemService(NotificationManager.class);}
 protected final boolean locked(){return getContext().getSystemService(KeyguardManager.class).isDeviceLocked();}

 private final NoticeIds ids=new NoticeIds(),channels=new NoticeIds();
 private static final NoticeTapInbox.Intents<Intent> INTENTS=new NoticeTapInbox.Intents<Intent>(){
  public String action(Intent intent){return intent.getAction();}
  public String data(Intent intent){return intent.getDataString();}
 };
 /** Created in load(); retained intents and the uncaptured queue live for this plugin instance. */
 private volatile NoticeTapInbox<Intent> workflowInbox;
 /** A capture committed: clear exactly that route from its Intent on main, then forget the Intent. */
 private final NoticeTapInbox.Captured<Intent> clearCapturedIntent=(intent,token)->noticeMain.post(()->{NoticeTapInbox<Intent> inbox=workflowInbox;if(inbox.data(token).equals(intent.getDataString()))intent.setData(null);inbox.release(intent,token);});

 @Override public void load(){
  super.load();
  HostNoticePoster.Config poster=posterConfig();
  workflowInbox=new NoticeTapInbox<>(routes(),poster.openAction,poster.askAction,poster.routePrefix);
  captureWorkflowTap(getActivity().getIntent());
 }
 @Override protected void handleOnDestroy(){noticeGate.destroy();super.handleOnDestroy();}
 @Override protected void handleOnNewIntent(Intent intent){super.handleOnNewIntent(intent);captureWorkflowTap(intent);}
 @Override protected void handleOnResume(){
  super.handleOnResume();
  NoticeWorker.submit(NOTICE_IO,()->{workflowInbox.drain(clearCapturedIntent);noticeChanged();},()->{/* Intents remain retained for retry. */});
 }
 @Override protected void handleOnPause(){ids.clear();NotificationMirror mirror=mirror();if(mirror!=null)mirror.redact();super.handleOnPause();}
 private void noticeChanged(){noticeMain.post(()->{if(!noticeGate.destroyed())notifyListeners(PENDING_WORKFLOW_TAP_EVENT,new JSObject(),true);});}
 private void captureWorkflowTap(Intent intent){
  NoticeTapInbox<Intent> inbox=workflowInbox;
  if(intent==null||inbox==null||inbox.token(intent,INTENTS)==null)return;
  // Capacitor forwards warm intents without Activity.setIntent. Retain the actual intent until its
  // encrypted capture commits. OS notices do not auto-cancel, so failed persistence plus process
  // death still leaves an explicit retry.
  getActivity().setIntent(intent);
  // load(), resume and renderer polling may observe the same Intent before the worker's successful
  // capture is cleared on main. Queue that object only once.
  String key=inbox.retain(intent,INTENTS);if(key==null)return;
  NoticeWorker.submit(NOTICE_IO,()->{inbox.offer(key,intent,clearCapturedIntent);noticeChanged();},
   ()->inbox.release(intent,key.substring(0,36)));
 }

 /** Presentation protocol of workflow notices the renderer may rely on. */
 @PluginMethod public void workflowPresentationCapabilities(PluginCall call){JSObject result=new JSObject();result.put("protocol",2);call.resolve(result);}

 /** The newest pending tap. An Ask whose own notice is gone opens like the notice body. */
 @PluginMethod public void pendingWorkflowTap(PluginCall call){
  String failure="Workflow notification link unavailable; retry after unlocking.";
  noticeMain.post(()->{try{foreground();captureWorkflowTap(getActivity().getIntent());noticeWork(call,failure,()->call.resolve(new JSObject(workflowInbox.pending(clearCapturedIntent,this::addQuestionNotice).toString())));}catch(Exception unavailable){call.reject(failure);}});
 }
 /** Completes the renderer's handling of the exact pending tap; a completed approval Ask keeps its notice and tap. */
 @PluginMethod public void consumeWorkflowTap(PluginCall call){noticeWork(call,"Workflow notification link was retained; retry.",()->{
  String opened=workflowInbox.consume(call.getString("token"),Boolean.TRUE.equals(call.getBoolean("discard",false)),call.getString("noticeRevision"),this::addQuestionNotice,this::requireNoticeForeground);
  if(opened!=null)manager().cancel(posterConfig().tagPrefix+opened,0);
  call.resolve();
 });}
 /** Question excerpts are read only while unlocked and only from the exact still-posted own notice. */
 private void addQuestionNotice(JSONObject pending)throws Exception{
  requireNoticeForeground();
  HostNoticePoster.Config poster=posterConfig();
  String operation=pending.getString("operationId"),tag=poster.tagPrefix+operation;
  for(StatusBarNotification row:manager().getActiveNotifications())if(row.getId()==0&&tag.equals(row.getTag())){
   Notification n=row.getNotification();
   String expected=NoticeDelivery.approvalId(operation)?poster.approvalChannel:poster.stepChannel;
   if(!expected.equals(n.getChannelId())||n.visibility==Notification.VISIBILITY_SECRET)return;
   String identity=ids.id(identity(row));
   pending.put("notice",new JSONObject().put("id",identity).put("revision",identity).put("source","own").put("appLabel",appLabel())
    .put("title",NoticeIds.bounded(n.extras.getCharSequence(Notification.EXTRA_TITLE),200))
    .put("text",NoticeIds.bounded(n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT,n.extras.getCharSequence(Notification.EXTRA_TEXT)),2000)));
   return;
  }
 }
 /** Records and posts one workflow notice at most once; resolves the ledger status. */
 @PluginMethod public void postWorkflow(PluginCall call){noticeWork(call,"Workflow notification could not be confirmed. It will not be repeated automatically.",()->{
  routes().prepare(call.getString("operationId"),call.getString("bindingHash"),call.getObject("route"));
  requireNoticeForeground();
  String status=delivery().publish(call.getString("operationId"),call.getString("bindingHash"),call.getString("title"),call.getString("body"));
  JSObject result=new JSObject();result.put("status",status);call.resolve(result);
 });}
 /** The retained receipt for an exact notice (never posts). */
 @PluginMethod public void workflowReceipt(PluginCall call){noticeWork(call,"Workflow notification receipt is unavailable.",()->{
  String status=delivery().receipt(call.getString("operationId"),call.getString("bindingHash"),call.getString("title"),call.getString("body"));
  JSObject result=new JSObject();result.put("status",status);call.resolve(result);
 });}

 private static String identity(StatusBarNotification row){return row.getKey()+"\n"+row.getPostTime();}
 private StatusBarNotification resolve(String id){if(id==null||id.isEmpty())return null;for(StatusBarNotification row:manager().getActiveNotifications())if(ids.names(id,identity(row)))return row;return null;}
 private static String interruption(int filter){
  return filter==NotificationManager.INTERRUPTION_FILTER_ALL?"all":filter==NotificationManager.INTERRUPTION_FILTER_PRIORITY?"priority":filter==NotificationManager.INTERRUPTION_FILTER_ALARMS?"alarms":filter==NotificationManager.INTERRUPTION_FILTER_NONE?"none":"unknown";
 }

 /** App-level delivery: enabled, permission, interruption filter and channels (opaque IDs). */
 @PluginMethod public void status(PluginCall call){try{
  NotificationManager manager=manager();JSObject out=new JSObject();JSArray values=new JSArray();Set<String> current=new HashSet<>();
  out.put("appEnabled",manager.areNotificationsEnabled());
  out.put("permissionGranted",Build.VERSION.SDK_INT<33||getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);
  out.put("interruption",interruption(manager.getCurrentInterruptionFilter()));
  for(NotificationChannel channel:manager.getNotificationChannels()){
   String key=channel.getId();current.add(key);JSObject row=new JSObject();
   row.put("id",channels.id(key));row.put("name",NoticeIds.bounded(channel.getName(),120));row.put("importance",channel.getImportance());row.put("blocked",channel.getImportance()==NotificationManager.IMPORTANCE_NONE);
   NotificationChannelGroup group=channel.getGroup()==null?null:manager.getNotificationChannelGroup(channel.getGroup());row.put("groupBlocked",group!=null&&group.isBlocked());values.put(row);
  }
  channels.retain(current);out.put("channels",values);out.put("scope",scope());call.resolve(out);
 }catch(RuntimeException error){call.reject("Notification delivery settings could not be read");}}
 @PluginMethod public void openChannelSettings(PluginCall call){try{
  String key=channels.key(call.getString("id"));
  if(key==null||manager().getNotificationChannel(key)==null){call.reject("This notification channel is no longer available");return;}
  getActivity().startActivity(new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getContext().getPackageName()).putExtra(Settings.EXTRA_CHANNEL_ID,key));
  JSObject out=new JSObject();out.put("status","opened");call.resolve(out);
 }catch(RuntimeException error){call.reject("Android channel settings could not be opened");}}

 /** The mirror, or throws so cross-app calls reject on a host without notification access. */
 private NotificationMirror requireMirror(){NotificationMirror mirror=mirror();if(mirror==null)throw new IllegalStateException("No notification access on this host");return mirror;}
 @PluginMethod public void crossAppStatus(PluginCall call){try{call.resolve(new JSObject(requireMirror().status(getContext()).toString()));}catch(Exception failure){call.reject("Notification access status is unavailable. History may need clearing.");}}
 @PluginMethod public void notificationApps(PluginCall call){try{foreground();JSObject out=new JSObject();out.put("apps",new JSArray(requireMirror().apps(getContext()).toString()));call.resolve(out);}catch(Exception failure){call.reject("Notification app choices are unavailable");}}
 @PluginMethod public void setNotificationPolicy(PluginCall call){try{foreground();call.resolve(new JSObject(requireMirror().update(getContext(),call.getData()).toString()));}catch(Exception failure){call.reject("Notification settings changed or could not be saved. Refresh Settings.");}}
 @PluginMethod public void resumeCrossApp(PluginCall call){try{
  foreground();NotificationMirror mirror=requireMirror();
  synchronized(mirror.lock){
   if(!mirror.status(getContext()).getString("revision").equals(call.getString("expectedRevision")))throw new IllegalStateException();
   mirror.pause(getContext(),false);call.resolve(new JSObject(mirror.status(getContext()).toString()));
  }
 }catch(Exception failure){call.reject("Notification collection could not be resumed");}}
 @PluginMethod public void openNotificationAccess(PluginCall call){try{
  foreground();NotificationMirror mirror=requireMirror();
  Intent intent=Build.VERSION.SDK_INT>=30?new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,mirror.component(getContext()).flattenToString()):new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
  try{getActivity().startActivity(intent);}catch(ActivityNotFoundException unavailable){getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));}
  JSObject out=new JSObject();out.put("status","opened");call.resolve(out);
 }catch(Exception failure){call.reject("Android notification access settings are unavailable");}}
 @PluginMethod public void notificationHistory(PluginCall call){try{foreground();JSObject out=new JSObject();out.put("items",new JSArray(requireMirror().history(getContext()).toString()));call.resolve(out);}catch(Exception failure){call.reject("Local notification history is unavailable");}}
 @PluginMethod public void clearNotificationHistory(PluginCall call){try{foreground();requireMirror().clearHistoryBoundary(getContext());call.resolve();}catch(Exception failure){call.reject("Local notification history could not be cleared");}}

 /** Own rows (newest first) then allowed cross-app rows, at most {@link #MAX_ROWS}. */
 @PluginMethod public void list(PluginCall call){try{
  JSArray items=new JSArray();Set<String> current=new HashSet<>();boolean locked=locked();String label=appLabel();
  StatusBarNotification[] rows=manager().getActiveNotifications();Arrays.sort(rows,Comparator.comparingLong(StatusBarNotification::getPostTime).reversed());
  for(StatusBarNotification row:rows){
   current.add(identity(row));if(items.length()>=MAX_ROWS)continue;Notification n=row.getNotification();JSObject item=new JSObject();
   boolean hidden=locked||n.visibility==Notification.VISIBILITY_SECRET;String id=ids.id(identity(row));
   item.put("id",id);item.put("revision",id);item.put("source","own");item.put("kind",noticeKind(n.getChannelId()));item.put("appLabel",label);
   item.put("title",hidden?label+" notification":NoticeIds.bounded(n.extras.getCharSequence(Notification.EXTRA_TITLE),200));
   item.put("text",hidden?(locked?"Unlock to view":"Content hidden"):NoticeIds.bounded(n.extras.getCharSequence(Notification.EXTRA_BIG_TEXT,n.extras.getCharSequence(Notification.EXTRA_TEXT)),2000));
   item.put("at",row.getPostTime());item.put("clearable",row.isClearable());item.put("canOpen",!hidden&&n.contentIntent!=null);items.put(item);
  }
  ids.retain(current);
  NotificationMirror mirror=mirror();
  if(mirror!=null){JSONArray external=mirror.list(getContext());for(int i=0;i<external.length()&&items.length()<MAX_ROWS;i++)items.put(external.get(i));}
  JSObject result=new JSObject();result.put("items",items);result.put("scope",scope());call.resolve(result);
 }catch(Exception error){call.reject("Notifications could not be read");}}
 @PluginMethod public void open(PluginCall call){try{
  foreground();
  if("external".equals(call.getString("source"))){requireMirror().action(getContext(),call.getString("id"),call.getString("revision"),true);call.resolve();return;}
  StatusBarNotification row=resolve(call.getString("id"));
  if(row==null||locked()||row.getNotification().visibility==Notification.VISIBILITY_SECRET||row.getNotification().contentIntent==null){call.reject("This notification is no longer available to open");return;}
  row.getNotification().contentIntent.send();
  if((row.getNotification().flags&Notification.FLAG_AUTO_CANCEL)!=0)manager().cancel(row.getTag(),row.getId());
  call.resolve();
 }catch(Exception error){call.reject("This notification could not be opened");}}
 @PluginMethod public void dismiss(PluginCall call){try{
  foreground();
  if("external".equals(call.getString("source"))){requireMirror().action(getContext(),call.getString("id"),call.getString("revision"),false);JSObject out=new JSObject();out.put("status","requested");call.resolve(out);return;}
  StatusBarNotification row=resolve(call.getString("id"));
  if(row==null){call.resolve();return;}
  if(!row.isClearable()){call.reject("This ongoing notification cannot be dismissed");return;}
  manager().cancel(row.getTag(),row.getId());call.resolve();
 }catch(Exception error){call.reject("Notification could not be dismissed");}}
 @PluginMethod public void clear(PluginCall call){try{
  foreground();JSONArray items=call.getArray("items");if(items==null||items.length()>MAX_ROWS)throw new IllegalArgumentException();
  JSArray outcomes=new JSArray();
  for(int i=0;i<items.length();i++){
   JSONObject item=items.getJSONObject(i);JSObject outcome=new JSObject();outcome.put("id",item.getString("id"));
   try{
    if("external".equals(item.optString("source")))requireMirror().action(getContext(),item.getString("id"),item.getString("revision"),false);
    else{StatusBarNotification row=resolve(item.getString("id"));if(row==null||!row.isClearable())throw new IllegalStateException();manager().cancel(row.getTag(),row.getId());}
    outcome.put("status","requested");
   }catch(Exception unavailable){outcome.put("status","unavailable");}
   outcomes.put(outcome);
  }
  JSObject out=new JSObject();out.put("outcomes",outcomes);call.resolve(out);
 }catch(Exception error){call.reject("Notifications could not be cleared");}}
}

package ai.eliza.plugins.reminders;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.time.*;
import java.util.UUID;

/** Device-local reminder storage and Android OS scheduling; no agent workflow executor. */
final class ReminderStore {
 private final String CHANNEL;
 private final String DUE_CHANNEL;
 private final String OPEN_ID;
 private final String OCCURRENCE;

 private final int LIMIT = 250;
 final ReminderConfiguration configuration;
 final SecureStringStore secure;
 final ReminderEnvelope.State persistence = new ReminderEnvelope.State();
 ReminderStore(ReminderConfiguration configuration, SecureStringStore secure) {
  this.configuration=configuration;this.secure=secure;
  CHANNEL=configuration.channelId;DUE_CHANNEL=configuration.dueChannelId();OPEN_ID=configuration.idExtra;OCCURRENCE=configuration.occurrenceExtra;
 }
 private ReminderEnvelope activeEnvelope;
 private ArrayList<Runnable> deferredEffects;
 private ReminderEnvelope envelope(Context context) { return activeEnvelope==null?new ReminderEnvelope(context,this):activeEnvelope; }
 private SharedPreferences prefs(Context context) { return envelope(context).records(); }
 private void effect(Runnable action){if(deferredEffects==null)action.run();else deferredEffects.add(action);}
 private void cancelAlarm(Context context,String id,String occurrence){effect(()->context.getSystemService(AlarmManager.class).cancel(pending(context,id,occurrence)));}
 private void cancelNotification(Context context,String id){effect(()->context.getSystemService(NotificationManager.class).cancel(configuration.notificationTag(id),0));}
 static boolean validId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{1,100}"); }
 /** Refusal before any write: the reminder ID is absent unless it already existed. */
 static final class StorageFull extends IllegalArgumentException { StorageFull() { super("Reminder storage is full. Complete or cancel an existing reminder before adding another."); } }
 void channel(Context context) {
  NotificationManager manager = context.getSystemService(NotificationManager.class);
  NotificationChannel legacy = new NotificationChannel(CHANNEL, configuration.channelName, NotificationManager.IMPORTANCE_DEFAULT);
  legacy.setDescription(configuration.channelDescription);
  legacy.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
  NotificationChannel existing = manager.getNotificationChannel(CHANNEL);
  manager.createNotificationChannel(legacy);
  if (manager.getNotificationChannel(DUE_CHANNEL) != null) return;
  // Channel importance is fixed at creation, so due reminders move to a separate
  // high-importance channel. Keep explicit importance choices and private previews.
  NotificationChannel due = new NotificationChannel(DUE_CHANNEL, configuration.channelName + " (due)",
   existing != null && (existing.getImportance() < NotificationManager.IMPORTANCE_DEFAULT || (Build.VERSION.SDK_INT >= 29 && existing.hasUserSetImportance())) ? existing.getImportance() : NotificationManager.IMPORTANCE_HIGH);
  due.setDescription(configuration.channelDescription);
  due.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
  if (existing != null) { due.setLockscreenVisibility(existing.getLockscreenVisibility()); due.setSound(existing.getSound(), existing.getAudioAttributes()); due.enableVibration(existing.shouldVibrate()); if (existing.getVibrationPattern() != null) due.setVibrationPattern(existing.getVibrationPattern()); due.setBypassDnd(false); }
  manager.createNotificationChannel(due);
 }
 boolean allowed(Context context) {
  NotificationManager manager = context.getSystemService(NotificationManager.class);
  if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
  NotificationChannel channel = manager.getNotificationChannel(DUE_CHANNEL);
  if (channel == null) channel = manager.getNotificationChannel(CHANNEL);
  return manager.areNotificationsEnabled() && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
 }
 String dueChannel() { return DUE_CHANNEL; }
 private PendingIntent pending(Context context, String id) { return pending(context,id,null); }
 private PendingIntent pending(Context context, String id, String occurrence) {
  Intent intent = new Intent(context, configuration.receiverClass).setAction(configuration.remindAction)
   .setData(Uri.parse(configuration.alarmUriPrefix + id + (occurrence==null?"":"/"+occurrence))).putExtra(OPEN_ID, id).putExtra(OCCURRENCE,occurrence);
  return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
 }
 static boolean noAlert(JSONObject record){return record!=null&&record.has("alertMinutes")&&record.isNull("alertMinutes");}
 /** Explicit timing is opt-in; legacy calls/receipts retain their original shape. */
 static JSONObject explicitTiming(JSONObject input,long at,JSONObject recurrence)throws JSONException {
  boolean due=input.has("dueAt"),alert=input.has("alertMinutes");
  if(!due&&!alert)return null;
  if(!due||!alert)throw new IllegalArgumentException("Reminder timing requires dueAt and alertMinutes together");
  Object raw=input.get("dueAt");
  if(!(raw instanceof Number)||!Double.isFinite(((Number)raw).doubleValue())||((Number)raw).doubleValue()<0||((Number)raw).doubleValue()>8640000000000000L||((Number)raw).doubleValue()!=((Number)raw).longValue())throw new IllegalArgumentException("Invalid reminder due time");
  long dueAt=((Number)raw).longValue();Object minutes=input.get("alertMinutes");int lead=0;
  if(minutes!=JSONObject.NULL){
   if(!(minutes instanceof Number)||!Double.isFinite(((Number)minutes).doubleValue())||((Number)minutes).doubleValue()<0||((Number)minutes).doubleValue()>10080||((Number)minutes).doubleValue()!=((Number)minutes).intValue())throw new IllegalArgumentException("Invalid reminder alert lead");
   lead=((Number)minutes).intValue();
  }
  if(at!=dueAt-lead*60000L)throw new IllegalArgumentException("Reminder alert time differs from due time");
  if(recurrence!=null){Object repeatLead=recurrence.get("leadMinutes");if(!(repeatLead instanceof Number)||((Number)repeatLead).doubleValue()!=lead)throw new IllegalArgumentException("Repeat alert lead differs");}
  return new JSONObject().put("dueAt",dueAt).put("alertMinutes",minutes==JSONObject.NULL?JSONObject.NULL:lead);
 }
 private void arm(Context context, String id, long at) {
  // Inexact alarms deliberately avoid the privileged/user-granted exact-alarm capability.
  String occurrence=null;
  try { JSONObject record=read(context,id);if(noAlert(record))return;if(record!=null)occurrence=record.optString("occurrenceId",null); }
  catch(JSONException error){throw new IllegalStateException("Reminder could not be read",error);}
  final String selectedOccurrence=occurrence;
  effect(()->context.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, Math.max(at, System.currentTimeMillis() + 1000), pending(context,id,selectedOccurrence)));
 }
 synchronized JSONObject schedule(Context context, String id, String title, String body, long at) throws JSONException {
  return schedule(context,id,title,body,at,null);
 }
 synchronized JSONObject schedule(Context context, String id, String title, String body, long at, JSONObject recurrence) throws JSONException {
  return schedule(context,id,title,body,at,recurrence,null);
 }
 synchronized JSONObject schedule(Context context, String id, String title, String body, long at, JSONObject recurrence, JSONObject timing) throws JSONException {
  return schedule(context,id,title,body,at,recurrence,timing,false);
 }
 private JSONObject schedule(Context context,String id,String title,String body,long at,JSONObject recurrence,JSONObject timing,boolean permissionAware)throws JSONException {
  if(timing!=null)timing=explicitTiming(timing,at,recurrence);
  if (!validId(id) || title == null || title.trim().isEmpty() || title.length() > 200 || body == null || body.length() > 4000) throw new IllegalArgumentException("Use a valid reminder ID, title up to 200 characters, and details up to 4000 characters");
  if (at <= System.currentTimeMillis()) throw new IllegalArgumentException("Choose a future reminder time");
  SharedPreferences preferences = prefs(context);
  String reclaimedId = null, reclaimedRecord = null;
  if (!preferences.contains(id) && preferences.getAll().size() >= LIMIT) {
   // Explicitly cancelled or completed records are terminal. Posted and denied
   // reminders remain unresolved; damaged records must also be retained.
   long oldestAt = Long.MAX_VALUE;
   for (String key : preferences.getAll().keySet()) {
    try {
     JSONObject candidate = read(context, key);
     if (candidate != null && ("cancelled".equals(candidate.optString("status")) || "completed".equals(candidate.optString("status")))
       && candidate.optLong("cancelledAt", candidate.optLong("completedAt", Long.MAX_VALUE)) < oldestAt) {
      reclaimedId = key; reclaimedRecord = candidate.toString();
      oldestAt = candidate.optLong("cancelledAt", candidate.optLong("completedAt"));
     }
    } catch (JSONException | ClassCastException invalid) { /* Preserve damaged neighbors. */ }
   }
   if (reclaimedId == null) throw new StorageFull();
  }
  JSONObject previous = read(context, id);
  if(previous!=null&&previous.has("alertMinutes")&&timing==null)throw new IllegalArgumentException("Explicit reminder timing must be preserved");
  JSONObject record = new JSONObject().put("id", id).put("title", title.trim()).put("body", body).put("at", at)
   .put("status", "scheduled").put("mode", "inexact").put("createdAt", System.currentTimeMillis());
  if(recurrence!=null) {
   initializeRecurrence(record,recurrence,at);
  }
  if(recurrence==null)record.put("occurrenceId",UUID.randomUUID().toString()).put("dueAt",at).put("history",new JSONArray());
  if(timing!=null){if(recurrence!=null&&record.getLong("dueAt")!=timing.getLong("dueAt"))throw new IllegalArgumentException("Repeat due time differs");record.put("dueAt",timing.getLong("dueAt")).put("alertMinutes",timing.get("alertMinutes"));if(noAlert(record))record.put("status","pending").put("mode","none");}
  if(permissionAware&&!noAlert(record)&&!allowed(context))record.put("status","permission-denied");
  if(previous!=null)record.put("history",previous.optJSONArray("history")==null?new JSONArray():previous.getJSONArray("history")).put("createdAt",previous.optLong("createdAt",System.currentTimeMillis()));
  SharedPreferences.Editor write = preferences.edit().putString(id, record.toString());
  if (reclaimedId != null) write.remove(reclaimedId);
  if (!write.commit()) throw new IllegalStateException("Reminder could not be saved");
  try { if(!permissionAware||"scheduled".equals(record.getString("status")))arm(context, id, at); }
  catch (RuntimeException error) {
   SharedPreferences.Editor editor = preferences.edit();
   if (previous == null) editor.remove(id); else editor.putString(id, previous.toString());
   if (reclaimedId != null) editor.putString(reclaimedId, reclaimedRecord);
   if(!editor.commit())throw new IllegalStateException("Reminder rollback failed",error); throw error;
  }
  if(previous!=null && !java.util.Objects.equals(previous.optString("occurrenceId",null),record.optString("occurrenceId",null))) cancelAlarm(context,id,previous.optString("occurrenceId",null));
  if(previous!=null||!noAlert(record)){cancelAlarm(context,id,null);cancelNotification(context,id);}
  return record;
 }
 synchronized JSONObject read(Context context, String id) throws JSONException {
  String value = prefs(context).getString(id, null); if(value==null)return null;
  JSONObject row=new JSONObject(value);
  // Old one-off records had no revision. Derive a stable identity without changing
  // their ID or deadline; a genuine old alarm is still accepted until mutation.
  if(!row.has("occurrenceId")&&!row.has("recurrence")){
   String seed=id+":"+row.optLong("createdAt")+":"+row.getLong("at");
   row.put("occurrenceId","legacy_"+UUID.nameUUIDFromBytes(seed.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
    .put("dueAt",row.getLong("at")).put("legacyAlarm",true);
   if(!row.has("history"))row.put("history",new JSONArray());
  }
  return row;
 }
 synchronized JSONArray list(Context context) throws JSONException {
  ArrayList<JSONObject> values = new ArrayList<>();
  for (String key : prefs(context).getAll().keySet()) {
   try { JSONObject value=read(context,key);if(value!=null){value.put("target",selected(context,key));values.add(value); } }
   catch (JSONException | ClassCastException invalid) { /* Preserve damaged records, but do not hide healthy reminders. */ }
  }
  // Undated to-dos have no instant; they follow every dated reminder.
  values.sort(Comparator.comparingLong(value -> value.optLong("at", Long.MAX_VALUE)));
  JSONArray result = new JSONArray(); for (JSONObject value : values) result.put(value); return result;
 }
 synchronized boolean cancel(Context context, String id) throws JSONException {
  if (!validId(id)) throw new IllegalArgumentException("Invalid reminder ID");
  JSONObject value = read(context, id); if (value == null) return false;
  // Persist cancellation before touching AlarmManager; the receiver checks the stored state.
  value.put("status", "cancelled").put("cancelledAt", System.currentTimeMillis());
  if (!prefs(context).edit().putString(id, value.toString()).commit()) throw new IllegalStateException("Cancellation could not be saved");
  cancelAlarm(context,id,value.optString("occurrenceId",null));
  cancelAlarm(context,id,null);
  cancelNotification(context,id); return true;
 }
 /** Stable for one device boot; changes after every reboot. */
 static String bootId(Context context) {
  int count = android.provider.Settings.Global.getInt(context.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, -1);
  if (count >= 0) return "count:" + count;
  return "wall:" + (System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime()) / 60000L;
 }
 private SharedPreferences bootMarker(Context context) { return context.getSharedPreferences(configuration.bootMarkerName(), Context.MODE_PRIVATE); }
 synchronized void restore(Context context) { restore(context, bootId(context)); }
 synchronized void restore(Context context, String boot) {
  // Recover each record independently. A damaged record or one failed alarm must
  // not suppress other reminders. Permission-denied records require explicit rescheduling.
  // Android clears notifications on reboot. Posted records are re-posted once per boot with
  // the same occurrence, target and tap route; recurrence never advances here.
  boolean repost = !boot.equals(bootMarker(context).getString("boot", null)), anyPosted = false, failed = false;
  if (repost) { try { channel(context); } catch (RuntimeException unavailable) { failed = true; } }
  boolean permitted = repost && !failed && allowed(context);
  for (String key : prefs(context).getAll().keySet()) {
   try {
    JSONObject value=read(context,key);
    if(value!=null && !noAlert(value) && "scheduled".equals(value.optString("status"))) arm(context,value.getString("id"),value.getLong("at"));
    else if(repost && value!=null && !noAlert(value) && "posted".equals(value.optString("status"))) {
     anyPosted = true;
     if (permitted) postNotification(context, value.getString("id"), value, value.optString("occurrenceId", null)); else failed = true;
    }
   } catch (RuntimeException | JSONException ignored) { if (repost) failed = true; /* Keep this record for inspection; continue recovery. */ }
  }
  // Retry on the next restore if any posted notice could not be re-posted.
  if (repost && (!failed || !anyPosted)) bootMarker(context).edit().putString("boot", boot).commit();
 }
 synchronized void deliver(Context context, String id) { deliver(context,id,null); }
 synchronized void deliver(Context context, String id, String occurrence) {
  if (!validId(id)) return;
  try {
   JSONObject value = read(context, id);
   if (value == null || noAlert(value) || !"scheduled".equals(value.optString("status"))) return;
   if(value.has("occurrenceId")&&!value.getString("occurrenceId").equals(occurrence)){
    if(occurrence!=null||!value.optBoolean("legacyAlarm"))return;
   }
   occurrence=value.optString("occurrenceId",null);
   long at = value.getLong("at");
   // A superseded PendingIntent can already be in flight while an ID is
   // rescheduled. Always honor the latest persisted deadline, with no early window.
   if (at > System.currentTimeMillis()) { arm(context, id, at); return; }
   channel(context);
   if (!allowed(context)) {
    value.put("status", "permission-denied"); if(!prefs(context).edit().putString(id, value.toString()).commit())throw new IllegalStateException("Reminder state could not be saved"); return;
   }
   value.put("status", "posted").put("postedAt", System.currentTimeMillis());
   postNotification(context,id,value,occurrence);
   if(!prefs(context).edit().putString(id, value.toString()).commit())throw new IllegalStateException("Reminder state could not be saved");
  } catch (RuntimeException | JSONException ignored) {
   // The persisted record stays unresolved if the provider/system fails; no false delivered receipt.
  }
 }

 private void postNotification(Context context,String id,JSONObject value,String occurrence)throws JSONException{
   final String token;
   try { token = new ReminderTaps(context,this).prepare(selectedRow(context, id, value)); }
   catch (Exception unavailable) { throw new IllegalStateException("Reminder route could not be saved", unavailable); }
   Intent open = new Intent(context, configuration.activityClass).setAction(configuration.openAction)
    .setData(Uri.parse(configuration.tapUriPrefix + token)).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
   PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
   channel(context);
   Notification publicVersion = new Notification.Builder(context, DUE_CHANNEL).setSmallIcon(android.R.drawable.ic_popup_reminder)
    .setContentTitle(configuration.publicTitle).build();
   Notification.Builder builder = new Notification.Builder(context, DUE_CHANNEL).setSmallIcon(android.R.drawable.ic_popup_reminder)
    .setContentTitle(value.getString("title")).setContentText(value.getString("body"))
    .setStyle(new Notification.BigTextStyle().bigText(value.getString("body")))
    .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
     .setContentIntent(tap).setOnlyAlertOnce(true).setAutoCancel(false).setCategory(Notification.CATEGORY_REMINDER);
   if(occurrence!=null){
    builder.addAction(new Notification.Action.Builder(null,"Done",decisionIntent(context,id,occurrence,"done")).build());
    builder.addAction(new Notification.Action.Builder(null,"Snooze 10 minutes",decisionIntent(context,id,occurrence,"snooze")).build());
   }
   context.getSystemService(NotificationManager.class).notify(configuration.notificationTag(id), 0, builder.build());
 }
 private void initializeRecurrence(JSONObject record,JSONObject config,long at)throws JSONException {
  String rule=config.getString("rule"),zone=config.getString("zone"),date=config.getString("date"),time=config.getString("time");
  if(!rule.equals("daily")&&!rule.equals("weekdays")&&!rule.equals("weekly"))throw new IllegalArgumentException("Unknown repeat rule");
  ZoneId z=ZoneId.of(zone);LocalDate day=LocalDate.parse(date);LocalTime clock=LocalTime.parse(time);
  int lead=config.getInt("leadMinutes");if(lead<0||lead>10080||clock.getSecond()!=0||clock.getNano()!=0)throw new IllegalArgumentException("Invalid repeat time");
  LocalDateTime civil=day.atTime(clock);
  if(z.getRules().getValidOffsets(civil).isEmpty())throw new IllegalArgumentException("This local time does not exist");
  if(rule.equals("weekdays")&&(day.getDayOfWeek()==DayOfWeek.SATURDAY||day.getDayOfWeek()==DayOfWeek.SUNDAY))throw new IllegalArgumentException("Choose a weekday for the first occurrence");
  long due=civil.atZone(z).withEarlierOffsetAtOverlap().toInstant().toEpochMilli();
  if(due-lead*60000L!=at)throw new IllegalArgumentException("Repeat time does not match reminder time");
  String revision=UUID.randomUUID().toString();
  record.put("recurrence",new JSONObject().put("rule",rule).put("zone",zone).put("date",date).put("time",time).put("leadMinutes",lead))
   .put("revision",revision).put("occurrenceId",revision+"_"+date).put("dueAt",due).put("history",new JSONArray());
 }
 private PendingIntent decisionIntent(Context context,String id,String occurrence,String action){
  Intent intent=new Intent(context,configuration.receiverClass).setAction(configuration.decisionAction)
   .setData(Uri.parse(configuration.decisionUriPrefix+id+"/"+occurrence+"/"+action)).putExtra(OPEN_ID,id).putExtra(OCCURRENCE,occurrence).putExtra(configuration.decisionExtra,action);
  return PendingIntent.getBroadcast(context,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
 }
 /** Completion-driven repeats: only explicit Done advances the civil schedule. */
 synchronized JSONObject decide(Context context,String id,String occurrence,String action)throws JSONException {
  if(!validId(id)||occurrence==null)throw new IllegalArgumentException("Select the current reminder occurrence");
  JSONObject value=read(context,id);
  if(value==null||!occurrence.equals(value.optString("occurrenceId"))||"cancelled".equals(value.optString("status"))||"completed".equals(value.optString("status")))return new JSONObject().put("status","stale");
  if(!action.equals("done")&&!action.equals("snooze"))throw new IllegalArgumentException("Unknown reminder action");
  // Undated to-dos have no instant or alert: Done/Snooze would arm an alarm. Use todoDecision.
  if(value.optBoolean("undated"))throw new IllegalArgumentException("Change undated to-dos from the to-do list");
  if(action.equals("snooze")&&noAlert(value))throw new IllegalArgumentException("Edit this reminder to enable a reviewed alert before snoozing");
  if(action.equals("snooze")&&"scheduled".equals(value.optString("status"))&&value.has("snoozedAt"))return new JSONObject().put("status","unchanged");
  long now=System.currentTimeMillis();
  if(action.equals("done")&&!value.has("recurrence")){
   JSONArray previous=value.optJSONArray("history"),history=new JSONArray();
   if(previous!=null)for(int i=Math.max(0,previous.length()-31);i<previous.length();i++)history.put(previous.get(i));
   history.put(new JSONObject().put("occurrenceId",occurrence).put("dueAt",value.getLong("dueAt")).put("completedAt",now).put("skippedDates",0));
   value.put("history",history).put("status","completed").put("completedAt",now);value.remove("legacyAlarm");
   if(!prefs(context).edit().putString(id,value.toString()).commit())throw new IllegalStateException("Reminder action could not be saved");
   cancelAlarm(context,id,occurrence);
   cancelAlarm(context,id,null);
   cancelNotification(context,id);
   return new JSONObject().put("status","completed");
  }
  if(action.equals("done")){
   JSONObject rule=value.getJSONObject("recurrence");ZoneId zone=ZoneId.of(rule.getString("zone"));LocalTime time=LocalTime.parse(rule.getString("time"));
   LocalDate day=LocalDate.parse(rule.getString("date"));String kind=rule.getString("rule");long at;int skipped=0;
   do{
    day=day.plusDays(kind.equals("weekly")?7:1);
    if(kind.equals("weekdays"))while(day.getDayOfWeek()==DayOfWeek.SATURDAY||day.getDayOfWeek()==DayOfWeek.SUNDAY)day=day.plusDays(1);
    LocalDateTime civil=day.atTime(time);
    // Future missing wall times use the first valid instant after the gap.
    ZonedDateTime next=zone.getRules().getValidOffsets(civil).isEmpty()?zone.getRules().getTransition(civil).getDateTimeAfter().atZone(zone):civil.atZone(zone).withEarlierOffsetAtOverlap();
    at=next.toInstant().toEpochMilli()-rule.getInt("leadMinutes")*60000L;
    if(at<=now)skipped++;
   }while(at<=now);
   JSONArray previous=value.optJSONArray("history"),history=new JSONArray();
   if(previous!=null)for(int i=Math.max(0,previous.length()-31);i<previous.length();i++)history.put(previous.get(i));
   history.put(new JSONObject().put("occurrenceId",occurrence).put("dueAt",value.getLong("dueAt")).put("completedAt",now).put("skippedDates",skipped));
   rule.put("date",day.toString());value.put("history",history).put("occurrenceId",value.getString("revision")+"_"+day).put("dueAt",at+rule.getInt("leadMinutes")*60000L).put("at",at);
   value.remove("snoozedAt");value.remove("postedAt");
  }else value.put("at",now+600000L).put("snoozedAt",now);
  value.remove("legacyAlarm");
  value.put("status",noAlert(value)?"pending":allowed(context)?"scheduled":"permission-denied");
  if(!prefs(context).edit().putString(id,value.toString()).commit())throw new IllegalStateException("Reminder action could not be saved");
  cancelAlarm(context,id,occurrence);cancelAlarm(context,id,null);cancelNotification(context,id);
  if("scheduled".equals(value.getString("status")))try{arm(context,id,value.getLong("at"));}catch(RuntimeException error){value.put("status","scheduling-failed");if(!prefs(context).edit().putString(id,value.toString()).commit())throw new IllegalStateException("Reminder failure state could not be saved");}
  return new JSONObject().put("status",value.getString("status"));
 }
 /** Undated to-do: no instant, no AlarmManager entry, no notification. */
 synchronized JSONObject saveTodo(Context context,String id,String title,String body)throws JSONException{
  if (!validId(id) || title == null || title.trim().isEmpty() || title.length() > 200 || body == null || body.length() > 4000 || title.indexOf(0)>=0 || body.indexOf(0)>=0) throw new IllegalArgumentException("Use a valid to-do ID, title up to 200 characters, and details up to 4000 characters");
  JSONObject previous=read(context,id);
  if(previous!=null){
   // A retried save of the same to-do is idempotent; any other existing ID is refused.
   if(previous.optBoolean("undated")&&previous.getString("title").equals(title.trim())&&previous.getString("body").equals(body))return previous;
   throw new IllegalArgumentException("Reminder ID already exists");
  }
  SharedPreferences preferences=prefs(context);String reclaimedId=null;
  if(preferences.getAll().size()>=LIMIT){
   long oldestAt=Long.MAX_VALUE;
   for(String key:preferences.getAll().keySet()){
    try{JSONObject candidate=read(context,key);if(candidate!=null&&("cancelled".equals(candidate.optString("status"))||"completed".equals(candidate.optString("status")))&&candidate.optLong("cancelledAt",candidate.optLong("completedAt",Long.MAX_VALUE))<oldestAt){reclaimedId=key;oldestAt=candidate.optLong("cancelledAt",candidate.optLong("completedAt"));}}
    catch(JSONException|ClassCastException invalid){/* Preserve damaged neighbors. */}
   }
   if(reclaimedId==null)throw new StorageFull();
  }
  JSONObject record=new JSONObject().put("id",id).put("title",title.trim()).put("body",body).put("status","todo").put("mode","none").put("undated",true)
   .put("createdAt",System.currentTimeMillis()).put("occurrenceId",UUID.randomUUID().toString()).put("history",new JSONArray());
  SharedPreferences.Editor write=preferences.edit().putString(id,record.toString());if(reclaimedId!=null)write.remove(reclaimedId);
  if(!write.commit())throw new IllegalStateException("To-do could not be saved");
  return record;
 }
 /** Exact reviewed target only: done, reopen or cancel one undated to-do. */
 synchronized JSONObject todoDecision(Context context,JSONObject target,String action)throws JSONException{
  if(target==null||action==null||!java.util.Arrays.asList("done","reopen","cancel").contains(action))throw new IllegalArgumentException("Unknown to-do action");
  String id=target.getString("reminderId");JSONObject row=read(context,id);
  if(row==null||!row.optBoolean("undated"))throw new IllegalArgumentException("To-do not found");
  if(!canonical(target).equals(canonical(selected(context,id))))throw new IllegalArgumentException("Selected reminder changed");
  String status=row.getString("status");long now=System.currentTimeMillis();
  if("cancelled".equals(status))throw new IllegalArgumentException("To-do is no longer active");
  if(action.equals("done")){
   if(!"todo".equals(status))throw new IllegalArgumentException("To-do is not open");
   JSONArray previous=row.optJSONArray("history"),history=new JSONArray();
   if(previous!=null)for(int i=0;i<previous.length();i++)history.put(previous.get(i));
   history.put(new JSONObject().put("occurrenceId",row.getString("occurrenceId")).put("completedAt",now));
   row.put("history",history).put("status","completed").put("completedAt",now);
  }else if(action.equals("reopen")){
   if(!"completed".equals(status))throw new IllegalArgumentException("To-do is not completed");
   row.put("status","todo").put("occurrenceId",UUID.randomUUID().toString());row.remove("completedAt");
  }else row.put("status","cancelled").put("cancelledAt",now);
  if(!prefs(context).edit().putString(id,row.toString()).commit())throw new IllegalStateException("To-do could not be saved");
  return new JSONObject().put("status",row.getString("status")).put("id",id).put("target",selected(context,id));
 }
 static String digest(String value){try{byte[] bytes=java.security.MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
 private String canonical(Object value)throws JSONException{if(value instanceof JSONObject){JSONObject obj=(JSONObject)value;ArrayList<String> keys=new ArrayList<>();for(java.util.Iterator<String> it=obj.keys();it.hasNext();)keys.add(it.next());java.util.Collections.sort(keys);StringBuilder s=new StringBuilder("{");for(String key:keys){if(s.length()>1)s.append(',');s.append(JSONObject.quote(key)).append(':').append(canonical(obj.get(key)));}return s.append('}').toString();}if(value instanceof JSONArray){JSONArray a=(JSONArray)value;StringBuilder s=new StringBuilder("[");for(int i=0;i<a.length();i++){if(i>0)s.append(',');s.append(canonical(a.get(i)));}return s.append(']').toString();}return value instanceof String?JSONObject.quote((String)value):String.valueOf(value);}
 private void exactKeys(JSONObject v,String...keys)throws JSONException{java.util.Set<String> expected=new java.util.HashSet<>(java.util.Arrays.asList(keys));if(v.length()!=expected.size())throw new IllegalArgumentException("Unexpected reminder fields");for(String key:keys)if(!v.has(key))throw new IllegalArgumentException("Missing reminder field");}
 synchronized JSONObject selected(Context context,String id)throws JSONException{
  if(!validId(id))throw new IllegalArgumentException("Invalid reminder ID");JSONObject row=read(context,id);if(row==null)throw new IllegalArgumentException("Reminder not found");
  return selectedRow(context, id, row);
 }
 private JSONObject selectedRow(Context context, String id, JSONObject row) throws JSONException {
  String source=envelope(context).active().getString("source");JSONObject target=new JSONObject().put("sourceId",source).put("sourceRevision",digest(source)).put("reminderId",id).put("occurrenceId",row.getString("occurrenceId")).put("revision",digest(canonical(row)));if(row.has("alertMinutes"))target.put("timingVersion",2);return target;
 }
 private JSONObject operationResult(Context context,String type,String id)throws JSONException{
  JSONObject row=read(context,id),target=selected(context,id);
  JSONObject result=new JSONObject().put("version",1).put("kind",type).put("sourceId",target.getString("sourceId")).put("reminderId",id).put("occurrenceId",target.getString("occurrenceId")).put("revision",target.getString("revision")).put("status",row.getString("status")).put("at",row.getLong("at"));
  if(row.has("alertMinutes"))result.put("dueAt",row.getLong("dueAt")).put("alertMinutes",row.get("alertMinutes"));
  if(type.equals("reminder_read_selected"))result.put("fields",new JSONObject().put("title",row.getString("title")).put("body",row.getString("body")).put("schedule",new JSONObject().put("at",row.getLong("at")).put("recurrence",row.has("recurrence")?row.getJSONObject("recurrence"):JSONObject.NULL)));
  if(type.equals("reminder_read_selected")&&row.has("alertMinutes"))result.getJSONObject("fields").getJSONObject("schedule").put("at",row.getLong("dueAt")-(row.isNull("alertMinutes")?0:row.getInt("alertMinutes")*60000L)).put("dueAt",row.getLong("dueAt")).put("alertMinutes",row.get("alertMinutes"));
  return result;
 }
 synchronized JSONObject operationReceipt(Context context,String operationId,String bindingHash,JSONObject operation)throws JSONException{
  if(operationId==null||bindingHash==null||operation==null)throw new IllegalArgumentException("Missing reminder receipt binding");
  JSONObject receipts=new ReminderEnvelope(context,this).value.getJSONObject("operations");
  if(!receipts.has(operationId))return new JSONObject().put("status","unknown");
  JSONObject saved=receipts.getJSONObject(operationId);
  if(!digest(bindingHash+":"+canonical(operation)).equals(saved.getString("argumentHash")))throw new IllegalArgumentException("Reminder receipt binding changed");
  return new JSONObject(saved.getJSONObject("response").toString());
 }
 /** No automatic replay of an uncertain Android effect. Same operation returns its original receipt. */
 synchronized JSONObject operate(Context context,String operationId,String bindingHash,JSONObject operation)throws JSONException{
  if(operationId==null||!operationId.matches("[A-Za-z0-9_-]{1,128}")||bindingHash==null||!bindingHash.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid reminder operation binding");
  String type=operation.getString("type");if(!java.util.Arrays.asList("reminder_create","reminder_read_selected","reminder_update","reminder_complete","reminder_snooze","reminder_cancel").contains(type))throw new IllegalArgumentException("Unsupported reminder operation");
  boolean creating=type.equals("reminder_create");
  if(creating)exactKeys(operation,"type","fields");else if(type.equals("reminder_update"))exactKeys(operation,"type","target","fields");else exactKeys(operation,"type","target");
  JSONObject target=creating?null:operation.getJSONObject("target");if(!creating){if(target.has("timingVersion")){exactKeys(target,"sourceId","sourceRevision","reminderId","occurrenceId","revision","timingVersion");if(!(target.get("timingVersion") instanceof Number)||target.getDouble("timingVersion")!=2)throw new IllegalArgumentException("Invalid reminder timing version");}else exactKeys(target,"sourceId","sourceRevision","reminderId","occurrenceId","revision");}
  ReminderEnvelope store=new ReminderEnvelope(context,this);String argumentHash=digest(bindingHash+":"+canonical(operation));JSONObject receipts=store.value.getJSONObject("operations");
  if(receipts.has(operationId)){JSONObject saved=receipts.getJSONObject(operationId);if(!argumentHash.equals(saved.getString("argumentHash")))throw new IllegalArgumentException("Reminder operation binding changed");return new JSONObject(saved.getJSONObject("response").toString());}
  if(receipts.length()>=500)throw new IllegalStateException("Reminder operation storage full");
  String id=creating?operationId:target.getString("reminderId");
  if(creating){if(store.value.getJSONObject("records").has(id))throw new IllegalArgumentException("Reminder creation ID already exists");}
  else if(!canonical(target).equals(canonical(selected(context,id))))throw new IllegalArgumentException("Selected reminder changed");
  if(!creating&&read(context,id).optBoolean("undated"))throw new IllegalArgumentException("Change undated to-dos from the to-do list");
  activeEnvelope=store;store.begin();deferredEffects=new ArrayList<>();ArrayList<Runnable> effects;
  try{
   JSONObject row=read(context,id);
   if(creating){
    JSONObject fields=operation.getJSONObject("fields");exactKeys(fields,"title","body","schedule");
    if(!(fields.opt("title") instanceof String)||!(fields.opt("body") instanceof String))throw new IllegalArgumentException("Invalid reminder text");
    String title=fields.getString("title"),body=fields.getString("body");
    if(title.isEmpty()||!title.equals(title.trim())||title.length()>200||body.length()>4000||title.indexOf(0)>=0||body.indexOf(0)>=0)throw new IllegalArgumentException("Invalid reminder text");
    JSONObject timing=fields.getJSONObject("schedule");exactKeys(timing,"at","dueAt","alertMinutes","recurrence");Object instant=timing.get("at");
    if(!(instant instanceof Number)||!Double.isFinite(((Number)instant).doubleValue())||((Number)instant).doubleValue()<0||((Number)instant).doubleValue()>8640000000000000L||((Number)instant).doubleValue()!=((Number)instant).longValue())throw new IllegalArgumentException("Invalid reminder instant");
    JSONObject recurrence=timing.isNull("recurrence")?null:timing.getJSONObject("recurrence");
    if(recurrence!=null){exactKeys(recurrence,"rule","zone","date","time","leadMinutes");for(String key:new String[]{"rule","zone","date","time"})if(!(recurrence.get(key) instanceof String))throw new IllegalArgumentException("Invalid repeat field");Object lead=recurrence.get("leadMinutes");if(!(lead instanceof Number)||((Number)lead).doubleValue()!=((Number)lead).intValue())throw new IllegalArgumentException("Invalid reminder lead");}
    schedule(context,id,title,body,((Number)instant).longValue(),recurrence,explicitTiming(timing,((Number)instant).longValue(),recurrence),true);
   }else if(type.equals("reminder_update")){
    if("cancelled".equals(row.optString("status")))throw new IllegalArgumentException("Reminder is no longer active");
    JSONObject fields=operation.getJSONObject("fields");if(fields.has("schedule"))exactKeys(fields,"title","body","schedule");else exactKeys(fields,"title","body");
    if(!(fields.opt("title") instanceof String)||!(fields.opt("body") instanceof String))throw new IllegalArgumentException("Invalid reminder fields");String title=fields.getString("title"),body=fields.getString("body");if(title.trim().isEmpty()||title.length()>200||body.length()>4000||title.indexOf(0)>=0||body.indexOf(0)>=0)throw new IllegalArgumentException("Invalid reminder text");
    if(fields.has("schedule")){JSONObject schedule=fields.getJSONObject("schedule");if(schedule.has("dueAt")||schedule.has("alertMinutes"))exactKeys(schedule,"at","recurrence","dueAt","alertMinutes");else exactKeys(schedule,"at","recurrence");Object at=schedule.get("at");if(!(at instanceof Number)||!Double.isFinite(((Number)at).doubleValue())||((Number)at).doubleValue()>8640000000000000L||((Number)at).doubleValue()<0||((Number)at).doubleValue()!=((Number)at).longValue())throw new IllegalArgumentException("Invalid reminder instant");JSONObject recurrence=schedule.isNull("recurrence")?null:schedule.getJSONObject("recurrence");if(recurrence!=null){exactKeys(recurrence,"rule","zone","date","time","leadMinutes");Object lead=recurrence.get("leadMinutes");if(!(lead instanceof Number)||((Number)lead).doubleValue()!=((Number)lead).intValue())throw new IllegalArgumentException("Invalid reminder lead");}JSONObject timing=explicitTiming(schedule,((Number)at).longValue(),recurrence);if(target.has("timingVersion")&&timing==null)throw new IllegalArgumentException("Explicit reminder timing must be preserved");if(!noAlert(timing)&&!allowed(context))throw new IllegalStateException("Reminder notification permission required");schedule(context,id,title,body,((Number)at).longValue(),recurrence,timing);}
    else{row.put("title",title.trim()).put("body",body);if(!prefs(context).edit().putString(id,row.toString()).commit())throw new IllegalStateException("Reminder save failed");if("posted".equals(row.optString("status")))effect(()->{try{postNotification(context,id,row,row.getString("occurrenceId"));}catch(JSONException e){throw new IllegalStateException(e);}});}
   }else if(type.equals("reminder_cancel"))cancel(context,id);
   else if(type.equals("reminder_complete")||type.equals("reminder_snooze")){JSONObject result=decide(context,id,target.getString("occurrenceId"),type.equals("reminder_complete")?"done":"snooze");if(result.optString("status").equals("stale"))throw new IllegalArgumentException("Reminder occurrence changed");}
   JSONObject result=operationResult(context,type,id);
   if(creating)result.put("fields",new JSONObject(operation.getJSONObject("fields").toString()));
   JSONObject response=new JSONObject().put("status",deferredEffects.isEmpty()?"succeeded":"unknown").put("result",result);
   JSONObject receipt=new JSONObject().put("argumentHash",argumentHash).put("phase",deferredEffects.isEmpty()?"terminal":"effects-pending").put("response",response);
   store.active().getJSONObject("operations").put(operationId,receipt);
   // All record changes and original absolute deadlines become durable together.
   store.commit();effects=deferredEffects;
  }catch(RuntimeException|JSONException failure){store.abort();throw failure;}finally{activeEnvelope=null;deferredEffects=null;}
  if(!effects.isEmpty()){
   boolean effectsComplete=false;
   try{for(Runnable action:effects)action.run();effectsComplete=true;JSONObject receipt=store.value.getJSONObject("operations").getJSONObject(operationId);receipt.put("phase","terminal");receipt.getJSONObject("response").put("status","succeeded");store.save();}
   catch(RuntimeException failure){
    try{JSONObject record=new JSONObject(store.value.getJSONObject("records").getString(id));if(!effectsComplete&&"scheduled".equals(record.optString("status"))){record.put("status","scheduling-failed");store.value.getJSONObject("records").put(id,record.toString());}JSONObject receipt=store.value.getJSONObject("operations").getJSONObject(operationId);receipt.put("phase","effects-uncertain");receipt.getJSONObject("response").put("status","unknown");store.save();}catch(RuntimeException|JSONException persistenceFailure){/* Previously committed unknown phase remains authoritative. */}
    return new JSONObject().put("status","unknown").put("message","Android reminder effect requires review; not repeated");
   }
  }
  return new JSONObject(store.value.getJSONObject("operations").getJSONObject(operationId).getJSONObject("response").toString());
 }

}

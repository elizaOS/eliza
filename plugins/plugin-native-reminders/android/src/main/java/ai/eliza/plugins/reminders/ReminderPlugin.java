package ai.eliza.plugins.reminders;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.*;
import com.getcapacitor.annotation.PermissionCallback;
/** Host subclasses and registers this bridge; all reminder effects remain owned by one engine. */
public abstract class ReminderPlugin extends Plugin {
 private final ReminderConfiguration configuration;
 private final SecureStringStore.Factory secureFactory;
 private volatile ReminderEngine engine;
 protected ReminderPlugin(ReminderConfiguration configuration,SecureStringStore.Factory secureFactory){this.configuration=java.util.Objects.requireNonNull(configuration);this.secureFactory=java.util.Objects.requireNonNull(secureFactory);}
 protected final ReminderEngine engine(){ReminderEngine value=engine;if(value==null){synchronized(this){value=engine;if(value==null)engine=value=ReminderEngine.get(getContext(),configuration,secureFactory);}}return value;}
 private static final ReminderIo REMINDER_IO = new ReminderIo();
 private final android.os.Handler reminderMain = new android.os.Handler(android.os.Looper.getMainLooper());
 private volatile boolean reminderDestroyed;
 private interface ReminderWork { void run() throws Exception; }
 @Override protected void handleOnDestroy() { reminderDestroyed = true; super.handleOnDestroy(); }
 private void reminderChanged() { reminderMain.post(() -> { if (!reminderDestroyed) notifyListeners("pendingReminderTap", new JSObject(), true); }); }
 private void clearReminderIntent(Intent intent, String token) { reminderMain.post(() -> { if ((configuration.tapUriPrefix + token).equals(intent.getDataString())) intent.setData(null); }); }
 private void requireReminderForeground() throws Exception {
  if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) throw new IllegalStateException("Storage must not run on main thread");
  java.util.concurrent.CountDownLatch checked = new java.util.concurrent.CountDownLatch(1);
  java.util.concurrent.atomic.AtomicBoolean admitted = new java.util.concurrent.atomic.AtomicBoolean();
  Runnable check = () -> { try { reminderForeground(); admitted.set(true); } catch (Exception inactive) {} finally { checked.countDown(); } };
  if (!reminderMain.post(check)) throw new IllegalStateException("Activity unavailable");
  if (!checked.await(5, java.util.concurrent.TimeUnit.SECONDS)) { reminderMain.removeCallbacks(check); throw new IllegalStateException("Activity check timed out"); }
  if (!admitted.get() || reminderDestroyed) throw new IllegalStateException("Activity inactive");
 }
 private void reminderWork(PluginCall call, String failure, ReminderWork work) {
  try { REMINDER_IO.execute(() -> { try { requireReminderForeground(); work.run(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); call.reject(failure); } catch (Exception unavailable) { call.reject(failure); } }); }
  catch (java.util.concurrent.RejectedExecutionException full) { call.reject(failure); }
 }
 private final java.util.LinkedHashMap<String,Intent> uncapturedReminderTaps=new java.util.LinkedHashMap<>();
 private ReminderTaps reminderTaps(){return engine().taps();}
 @Override public void load(){super.load();engine().restore();openReminder(getActivity().getIntent());}
 @Override protected void handleOnNewIntent(Intent intent){super.handleOnNewIntent(intent);openReminder(intent);}
 @Override protected void handleOnResume(){super.handleOnResume();try { REMINDER_IO.execute(() -> { drainReminderTaps(); reminderChanged(); }); } catch (java.util.concurrent.RejectedExecutionException full) { /* Original intent and OS notice remain available. */ } notifyListeners("appResumed",new JSObject(),true);}
 public static void addReminderCapabilities(JSObject value){value.put("reminderTimingVersion",2);value.put("reminderCreationVersion",1);value.put("reminderTapVersion",1);value.put("reminderStatusVersion",1);value.put("reminderTodoVersion",1);}
 private static Double number(PluginCall call,String key){Object value=call.getData().opt(key);return value instanceof Number?((Number)value).doubleValue():null;}
 private void openReminder(Intent intent) {
  if (intent == null) return;
  if (configuration.openAction.equals(intent.getAction()) && intent.getData() != null && intent.getData().toString().startsWith(configuration.tapUriPrefix)) {
   String token = intent.getData().toString().substring(configuration.tapUriPrefix.length());
   if (!token.matches("[a-f0-9-]{36}")) return;
   // Capacitor does not set Activity.intent for warm callbacks. Keep failed capture
   // and the non-auto-cancelled notification available until encrypted persistence.
   getActivity().setIntent(intent);
   try { REMINDER_IO.execute(() -> {
    if (!uncapturedReminderTaps.containsKey(token) && uncapturedReminderTaps.size() < 512) uncapturedReminderTaps.put(token, intent);
    drainReminderTaps(); reminderChanged();
   }); } catch (java.util.concurrent.RejectedExecutionException full) { /* Retain the original intent and non-auto-cancelled notice. */ }
   return;
  }
  // Legacy read-only deep links remain supported; new OS notices use opaque routes.
  String id = intent.getStringExtra(configuration.idExtra);
  if (ReminderStore.validId(id)) {
   JSObject result = new JSObject(); result.put("id", id); result.put("occurrenceId",intent.getStringExtra(configuration.occurrenceExtra));
   notifyListeners("reminderOpened", result, true);
   intent.removeExtra(configuration.idExtra);intent.removeExtra(configuration.occurrenceExtra);
  }
 }
 private int drainReminderTaps() {
  int failed = 0;
  java.util.Iterator<java.util.Map.Entry<String, Intent>> entries = uncapturedReminderTaps.entrySet().iterator();
  while (entries.hasNext()) {
   java.util.Map.Entry<String, Intent> entry = entries.next();
   try { reminderTaps().capture(entry.getKey()); clearReminderIntent(entry.getValue(), entry.getKey()); entries.remove(); }
   catch (ReminderTaps.UnknownTap unknown) { clearReminderIntent(entry.getValue(), entry.getKey()); entries.remove(); }
   catch (Exception unavailable) { failed++; }
  }
  return failed;
 }
 private void reminderForeground() {
  android.app.KeyguardManager keyguard = getContext().getSystemService(android.app.KeyguardManager.class);
  if (reminderDestroyed || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed() || !getActivity().hasWindowFocus() || keyguard == null || keyguard.isDeviceLocked()) throw new IllegalStateException("Unlock to open reminder");
 }
 @PluginMethod public void pendingReminderTap(PluginCall call) {
  reminderMain.post(() -> {
   try {
    reminderForeground(); openReminder(getActivity().getIntent());
    reminderWork(call, "Reminder link is retained. Unlock and retry.", () -> {
     int failed = drainReminderTaps(); org.json.JSONObject pending = reminderTaps().pending();
     if (failed > 0 && !pending.has("token")) throw new IllegalStateException("Reminder tap not captured");
     call.resolve(new JSObject(pending.toString()));
    });
   } catch (Exception unavailable) { call.reject("Reminder link is retained. Unlock and retry."); }
  });
 }
 @PluginMethod public void consumeReminderTap(PluginCall call) {
  reminderWork(call, "Reminder link changed or could not be saved. Refresh and retry.", () -> { reminderTaps().consume(call.getString("token")); call.resolve(); });
 }
 @PluginMethod public void dismissReminderTap(PluginCall call) {
  reminderWork(call, "Reminder link could not be dismissed. Refresh and retry.", () -> { reminderTaps().dismiss(call.getString("token")); call.resolve(); });
 }
 @PluginMethod public void scheduleReminder(PluginCall call) {
  String id = call.getString("id", ""), title = call.getString("title", ""), body = call.getString("body", "");
  Double at = number(call, "at");
  if (!ReminderStore.validId(id) || title.trim().isEmpty() || title.length() > 200 || body.length() > 4000 || at == null || !Double.isFinite(at) || at > Long.MAX_VALUE) {
   reminderResult(call, "failed", "Enter a valid reminder ID, title, and date"); return;
  }
  if (at <= System.currentTimeMillis()) { reminderResult(call, "past", "Choose a future reminder time"); return; }
  try {if((call.getData().has("dueAt")||call.getData().has("alertMinutes"))&&at.doubleValue()!=at.longValue())throw new IllegalArgumentException("Invalid reminder instant");if(ReminderStore.noAlert(ReminderStore.explicitTiming(call.getData(),at.longValue(),call.getObject("recurrence")))){completeReminder(call);return;}}
  catch(RuntimeException|org.json.JSONException invalid){reminderResult(call,"failed","Enter a valid reminder due time and alert");return;}
  engine().store.channel(engine().context);
  if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
   requestPermissionForAlias("notifications", call, "reminderPermissionResult"); return;
  }
  completeReminder(call);
 }
 @PermissionCallback private void reminderPermissionResult(PluginCall call) { completeReminder(call); }
 private void completeReminder(PluginCall call) {
  Double at = number(call, "at");
  if (at == null || at <= System.currentTimeMillis()) { reminderResult(call, "past", "Choose a future reminder time"); return; }
  try {
   org.json.JSONObject timing=ReminderStore.explicitTiming(call.getData(),at.longValue(),call.getObject("recurrence"));
   if(!ReminderStore.noAlert(timing)&&!engine().store.allowed(engine().context)){reminderResult(call,"permission-denied","Enable app notifications and its "+configuration.channelName+" (due) channel in Android settings");return;}
   final org.json.JSONObject saved;
   try{saved=engine().store.schedule(engine().context,call.getString("id"),call.getString("title"),call.getString("body",""),at.longValue(),call.getObject("recurrence"),timing);}
   catch(ReminderStore.StorageFull full){reminderResult(call,"storage-full","Reminder storage is full. Complete or cancel an existing reminder before adding another.");return;}
   JSObject value=new JSObject();value.put("status",saved.getString("status"));value.put("id",call.getString("id"));value.put("at",at.longValue());value.put("mode",saved.getString("mode"));
   if(timing!=null)value.put("dueAt",saved.getLong("dueAt")).put("alertMinutes",saved.get("alertMinutes"));
   value.put("message",ReminderStore.noAlert(saved)?"Saved on this device without an alert.":"Saved on this device. Android may delay this reminder to conserve battery.");call.resolve(value);
  } catch (RuntimeException | org.json.JSONException error) { reminderResult(call, "failed", "The reminder could not be saved or scheduled"); }
 }
 /** Undated to-do. Stable statuses: saved, storage-full, failed. No alarm or notification. */
 @PluginMethod public void saveTodo(PluginCall call) {
  try{org.json.JSONObject saved=engine().store.saveTodo(engine().context,call.getString("id",""),call.getString("title",""),call.getString("body",""));JSObject value=new JSObject();value.put("status","saved");value.put("id",saved.getString("id"));value.put("target",engine().store.selected(engine().context,saved.getString("id")));value.put("mode","none");value.put("message","Saved on this device as a to-do without a date or alert.");call.resolve(value);}
  catch(ReminderStore.StorageFull full){reminderResult(call,"storage-full","Reminder storage is full. Complete or cancel an existing reminder before adding another.");}
  catch(RuntimeException|org.json.JSONException error){reminderResult(call,"failed","The to-do could not be saved");}
 }
 @PluginMethod public void todoDecision(PluginCall call) {
  try{call.resolve(JSObject.fromJSONObject(engine().store.todoDecision(engine().context,call.getObject("target"),call.getString("action"))));}
  catch(RuntimeException|org.json.JSONException error){call.reject("To-do changed or could not be saved. Refresh before retrying.");}
 }
 @PluginMethod public void reminderDecision(PluginCall call) {
  try { call.resolve(JSObject.fromJSONObject(engine().store.decide(engine().context,call.getString("id"),call.getString("occurrenceId"),call.getString("action")))); }
  catch(RuntimeException|org.json.JSONException error){reminderResult(call,"failed","The reminder action could not be saved");}
 }
 @PluginMethod public void selectedReminder(PluginCall call) {
  try{call.resolve(JSObject.fromJSONObject(engine().store.selected(engine().context,call.getString("id"))));}catch(RuntimeException|org.json.JSONException error){call.reject("Selected reminder is unavailable");}
 }
 @PluginMethod public void reminderOperationReceipt(PluginCall call) {
  try{call.resolve(JSObject.fromJSONObject(engine().store.operationReceipt(engine().context,call.getString("operationId"),call.getString("bindingHash"),call.getObject("operation"))));}catch(RuntimeException|org.json.JSONException error){call.reject("Reminder receipt binding unavailable");}
 }
 @PluginMethod public void operateReminder(PluginCall call) {
  try{call.resolve(JSObject.fromJSONObject(engine().store.operate(engine().context,call.getString("operationId"),call.getString("bindingHash"),call.getObject("operation"))));}catch(RuntimeException|org.json.JSONException error){call.reject("Reminder operation could not be confirmed; review saved state before retrying");}
 }
 @PluginMethod public void listReminders(PluginCall call) {
  try { JSObject value = new JSObject(); value.put("reminders", engine().store.list(engine().context)); value.put("notificationsEnabled", engine().store.allowed(engine().context)); call.resolve(value); }
  catch (RuntimeException | org.json.JSONException error) { call.reject("Saved reminders could not be read"); }
 }
 @PluginMethod public void cancelReminder(PluginCall call) {
  try {
   org.json.JSONObject target=call.getObject("target");
   if(target==null||!target.getString("reminderId").equals(call.getString("id")))throw new IllegalArgumentException("Reviewed target required");
   org.json.JSONObject operation=new org.json.JSONObject().put("type","reminder_cancel").put("target",target);
   org.json.JSONObject response=engine().store.operate(engine().context,call.getString("operationId"),call.getString("bindingHash"),operation);
   reminderResult(call,"succeeded".equals(response.optString("status"))?"cancelled":"unknown","");
  } catch (RuntimeException | org.json.JSONException error) { call.reject("Cancellation requires the exact reviewed target; inspect saved state before retrying"); }
 }
 private void reminderResult(PluginCall call, String status, String message) {
  JSObject value = new JSObject(); value.put("id", call.getString("id", "")); value.put("status", status); value.put("mode", "inexact"); value.put("message", message); call.resolve(value);
 }
}

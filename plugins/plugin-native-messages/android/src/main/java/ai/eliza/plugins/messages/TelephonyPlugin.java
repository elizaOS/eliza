package ai.eliza.plugins.messages;

import android.Manifest;
import android.app.role.RoleManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Phone roles, SIMs and SMS/MMS for installs admitted to the AOSP telephony profile. The host
 * subclasses this under its own Capacitor plugin name (annotation on the subclass only, so plugin
 * discovery never lists this abstract base), registers the subclass only when its
 * {@link SmsTelephonyConfiguration#admission} holds, and declares the permission aliases
 * {@code contacts}, {@code phoneState}, {@code sms} and {@code sendSms}. Every method checks the
 * admission again, so a standalone APK, a sideloaded launcher or saved renderer state can never reach
 * a provider, a SIM or the radio.
 *
 * Reads: Telecom/SMS roles and default handlers, active subscriptions (phone-state access) and SMS/MMS
 * threads and messages through the Telephony providers (SMS access), in bounded pages, cancelled on
 * background, lock, screen-off and permission change, and fenced again before publication.
 *
 * Effects: dialing is always a handoff to the user's dialer, which also owns emergency numbers. A text
 * is sent natively only when SEND_SMS is held (granted on the image, or through the SMS role) and the
 * owner confirms the host's own native review of the exact recipients, text, SIM and part count on the
 * unlocked phone; the send then follows {@link SmsTelephony}: "sent" only from sent callbacks,
 * "delivered" only from delivery reports, never resent automatically. Without that permission the SMS
 * app handoff remains, and a handoff is never reported as sent. Roles are requested only through
 * Android's own dialog and only when the host declares the components the role needs. While the host
 * holds the SMS role, opening a conversation marks its received messages read up to the newest one
 * shown ({@link #markThreadRead}); Android accepts that provider write only from the default SMS app.
 */
@androidx.annotation.RequiresApi(29) // RoleManager and SIM carrier identity; profile hosts target Android 10 and later.
public abstract class TelephonyPlugin extends Plugin {
 public static final Pattern NUMBER = Pattern.compile("^\\+?[0-9]{2,20}$");
 public static final int MAX_RECIPIENTS = 10, MAX_BODY = 5000, MAX_SUBSCRIPTIONS = 8, MAX_TEXT = 256;
 /** Fixed answer for a request that reached a destroyed activity; it claims nothing about the effect. */
 public static final String CLOSED = "Android could not show this request; the app may have closed. Reopen it and try again.";
 public static final String UNAVAILABLE = "Phone, Contacts and Messages are available only on the phone's system image.";
 private static final String[] ALIASES = { "contacts", "phoneState", "sms", "sendSms" };

 /** The host's migration-sensitive identity and capability profile. Called once from {@link #load()}. */
 protected abstract SmsTelephonyConfiguration configuration();
 /** The answer when the profile does not admit this install or the phone is locked or in the background. */
 protected String unavailableMessage() { return UNAVAILABLE; }

 private SmsTelephonyConfiguration config;
 private final ExecutorService reader = Executors.newSingleThreadExecutor();
 private volatile boolean closed, foreground = true;
 private final AtomicLong generation = new AtomicLong();
 private final java.util.Set<android.os.CancellationSignal> reads = java.util.concurrent.ConcurrentHashMap.newKeySet();
 private final android.content.BroadcastReceiver screenOff = new android.content.BroadcastReceiver() {
  @Override public void onReceive(android.content.Context context, Intent intent) { invalidateReads(); }
 };
 private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
 private final SmsTelephony.Listener sendListener = operationId -> main.post(() -> {
  if (admitted() && unlockedForeground()) { JSObject value = new JSObject(); value.put("operationId", operationId); notifyListeners("smsSendUpdated", value); }
 });

 @Override public void load() {
  CapacitorPlugin annotation = getClass().getAnnotation(CapacitorPlugin.class);
  java.util.Set<String> declared = new java.util.HashSet<>();
  if (annotation != null) for (Permission permission : annotation.permissions()) declared.add(permission.alias());
  for (String alias : ALIASES) if (!declared.contains(alias)) throw new IllegalStateException("Telephony host plugin must declare permission alias " + alias);
  config = configuration();
  androidx.core.content.ContextCompat.registerReceiver(getContext(), screenOff, new android.content.IntentFilter(Intent.ACTION_SCREEN_OFF), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
  if (admitted()) {
   SmsTelephony.listen(sendListener);
   // Startup reconciliation: an interrupted dispatch becomes unknown; delivery evidence is re-read.
   SmsTelephony.reconcileLater(getContext(), config);
  }
 }
 protected final SmsTelephonyConfiguration telephonyConfiguration() { return config; }
 protected final boolean admitted() { return config != null && config.admission.admitted(getContext()); }
 /** Unlocked, unclosed, foreground user and activity: the only state in which provider content may be published. */
 protected final boolean unlockedForeground() {
  android.app.KeyguardManager lock = getContext().getSystemService(android.app.KeyguardManager.class);
  android.os.UserManager users = getContext().getSystemService(android.os.UserManager.class);
  return !closed && foreground && lock != null && !lock.isDeviceLocked() && users != null && users.isUserUnlocked()
   && (android.os.Build.VERSION.SDK_INT < 31 || users.isUserForeground()) && getActivity() != null && !getActivity().isFinishing() && !getActivity().isDestroyed();
 }
 private void invalidateReads() { generation.incrementAndGet(); for (android.os.CancellationSignal read : reads) read.cancel(); stopObserving(); cancelReview(); }
 @Override protected void handleOnPause() { foreground = false; invalidateReads(); super.handleOnPause(); }
 @Override protected void handleOnResume() { foreground = true; invalidateReads(); resumeObserving(); super.handleOnResume(); }
 /** Rejects the call unless the profile admits this install and the phone is unlocked with the host in front. */
 protected final boolean refused(PluginCall call) {
  if (call == null) return true;
  if (admitted() && unlockedForeground()) return false;
  call.reject(unavailableMessage(), "unavailable");
  return true;
 }
 protected static String clip(CharSequence value) {
  String text = value == null ? "" : value.toString();
  return text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) : text;
 }
 /** Runs a request that launches through the activity; a destroyed activity rejects instead of crashing the bridge thread. */
 protected static boolean launch(PluginCall call, Runnable start) {
  try { start.run(); return true; } catch (IllegalStateException gone) { call.reject(CLOSED); return false; }
 }

 // Capacitor's inherited permission request launches through the activity; answer a late call instead of throwing.
 @Override @PluginMethod public void requestPermissions(PluginCall call) { if (refused(call)) return; launch(call, () -> super.requestPermissions(call)); }
 @Override @PluginMethod public void checkPermissions(PluginCall call) { if (refused(call)) return; super.checkPermissions(call); }

 /** Presence of this method in the injected plugin headers is how renderers detect the profile. */
 @PluginMethod public void imageCapability(PluginCall call) {
  if (refused(call)) return;
  JSObject value = new JSObject();
  value.put("version", 1); value.put("image", true); value.put("feature", config.imageFeature);
  call.resolve(value);
 }

 @PluginMethod public void status(PluginCall call) { if (!refused(call)) call.resolve(statusObject()); }

 private JSObject roleState(RoleManager roles, String role, boolean eligible) {
  JSObject value = new JSObject();
  boolean available = roles != null && roles.isRoleAvailable(role);
  value.put("available", available);
  value.put("held", available && roles.isRoleHeld(role));
  value.put("eligible", eligible);
  return value;
 }
 /** Whether the host declares, and has enabled, what Android requires before it grants the role. A request that could only be refused is never shown. */
 protected boolean eligibleFor(String role) {
  PackageManager packages = getContext().getPackageManager();
  String self = getContext().getPackageName();
  if (RoleManager.ROLE_DIALER.equals(role))
   return declares(packages.queryIntentActivities(new Intent(Intent.ACTION_DIAL).setPackage(self), 0))
     && declares(packages.queryIntentServices(new Intent("android.telecom.InCallService").setPackage(self), 0));
  if (RoleManager.ROLE_SMS.equals(role))
   return declares(packages.queryBroadcastReceivers(new Intent(Telephony.Sms.Intents.SMS_DELIVER_ACTION).setPackage(self), 0))
     && declares(packages.queryBroadcastReceivers(new Intent(Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION).setPackage(self), 0))
     && declares(packages.queryIntentServices(new Intent(TelephonyManager.ACTION_RESPOND_VIA_MESSAGE).setData(Uri.fromParts("smsto", "0", null)).setPackage(self), 0))
     && declares(packages.queryIntentActivities(new Intent(Intent.ACTION_SENDTO).setData(Uri.fromParts("smsto", "0", null)).setPackage(self), 0));
  return false;
 }
 private static boolean declares(List<ResolveInfo> found) { return found != null && !found.isEmpty(); }

 protected JSObject statusObject() {
  JSObject value = new JSObject();
  TelephonyManager telephony = getContext().getSystemService(TelephonyManager.class);
  TelecomManager telecom = getContext().getSystemService(TelecomManager.class);
  RoleManager roles = getContext().getSystemService(RoleManager.class);
  value.put("version", 2);
  value.put("voiceCapable", telephony != null && telephony.isVoiceCapable());
  value.put("smsCapable", telephony != null && telephony.isSmsCapable());
  JSObject permissions = new JSObject();
  PermissionState contacts = getPermissionState("contacts"), phoneState = getPermissionState("phoneState");
  PermissionState sms = getPermissionState("sms"), sendSms = getPermissionState("sendSms");
  permissions.put("contacts", contacts.toString());
  permissions.put("phoneState", phoneState.toString());
  permissions.put("sms", sms.toString());
  permissions.put("sendSms", sendSms.toString());
  value.put("permissions", permissions);
  // Direct sends need SEND_SMS (granted, or held through the SMS role) and phone-state access to
  // confirm the reviewed SIM is active. Otherwise the SMS app handoff is the only path.
  boolean direct = telephony != null && telephony.isSmsCapable() && sendSms == PermissionState.GRANTED && phoneState == PermissionState.GRANTED;
  value.put("sendMode", direct ? "direct" : "handoff");
  JSObject roleStates = new JSObject();
  roleStates.put("dialer", roleState(roles, RoleManager.ROLE_DIALER, eligibleFor(RoleManager.ROLE_DIALER)));
  roleStates.put("sms", roleState(roles, RoleManager.ROLE_SMS, eligibleFor(RoleManager.ROLE_SMS)));
  value.put("roles", roleStates);
  String dialer, smsApp;
  try { dialer = telecom == null ? null : telecom.getDefaultDialerPackage(); } catch (RuntimeException unreadable) { dialer = null; }
  try { smsApp = Telephony.Sms.getDefaultSmsPackage(getContext()); } catch (RuntimeException unreadable) { smsApp = null; }
  value.put("defaultDialer", dialer == null ? JSONObject.NULL : dialer);
  value.put("defaultSms", smsApp == null ? JSONObject.NULL : smsApp);
  Object subscriptions = phoneState == PermissionState.GRANTED ? subscriptions() : JSONObject.NULL;
  value.put("subscriptions", subscriptions);
  // The system default SMS subscription, only when it is one of the active SIMs read above.
  Object defaultSubscription = JSONObject.NULL;
  if (subscriptions instanceof JSArray) {
   JSArray rows = (JSArray) subscriptions;
   for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.optJSONObject(i); if (row != null && row.optBoolean("defaultSms")) defaultSubscription = row.optInt("id"); }
  }
  value.put("defaultSmsSubscriptionId", defaultSubscription);
  return value;
 }
 /** Active SIM subscriptions, or JSON null when Android refuses the read: never an empty list in its place. */
 private Object subscriptions() {
  List<SubscriptionInfo> active = SmsTelephony.activeSubscriptions(getContext(), config);
  if (active == null) return JSONObject.NULL;
  JSArray rows = new JSArray();
  int sms = SubscriptionManager.getDefaultSmsSubscriptionId(), voice = SubscriptionManager.getDefaultVoiceSubscriptionId();
  for (SubscriptionInfo info : active) {
   if (rows.length() >= MAX_SUBSCRIPTIONS) break;
   if (info == null || info.getSubscriptionId() < 0 || info.getSimSlotIndex() < 0) continue;
   JSObject row = new JSObject();
   row.put("id", info.getSubscriptionId()); row.put("slot", info.getSimSlotIndex());
   row.put("displayName", clip(info.getDisplayName())); row.put("carrierName", clip(info.getCarrierName()));
   row.put("defaultSms", info.getSubscriptionId() == sms); row.put("defaultVoice", info.getSubscriptionId() == voice);
   rows.put(row);
  }
  return rows;
 }

 /** Asks for contacts, phone-state, SMS or send access in Android's own dialog, only from an explicit request. */
 @PluginMethod public void requestAccess(PluginCall call) {
  if (refused(call)) return;
  String access = call.getString("access", "");
  if (!java.util.Arrays.asList(ALIASES).contains(access)) { call.reject("Choose contacts, phone-state, SMS or send access", "invalid"); return; }
  if (getPermissionState(access) == PermissionState.GRANTED) { call.resolve(statusObject()); return; }
  launch(call, () -> requestPermissionForAlias(access, call, "accessResult"));
 }
 @PermissionCallback private void accessResult(PluginCall call) { invalidateReads(); if (!refused(call)) call.resolve(statusObject()); }

 /** Opens Android's role dialog for the dialer or SMS role. The user decides; the result is re-read. */
 @PluginMethod public void requestRole(PluginCall call) {
  if (refused(call)) return;
  String name = call.getString("role", "");
  String role = "dialer".equals(name) ? RoleManager.ROLE_DIALER : "sms".equals(name) ? RoleManager.ROLE_SMS : null;
  if (role == null) { call.reject("Choose the dialer or SMS role", "invalid"); return; }
  RoleManager roles = getContext().getSystemService(RoleManager.class);
  if (roles == null || !roles.isRoleAvailable(role)) { call.reject("This device does not offer that role", "unavailable"); return; }
  if (roles.isRoleHeld(role)) { call.resolve(statusObject()); return; }
  if (!eligibleFor(role)) { call.reject("This app cannot hold this role in this build. Your current app keeps it.", "not-eligible"); return; }
  launch(call, () -> startActivityForResult(call, roles.createRequestRoleIntent(role), "roleResult"));
 }
 @ActivityCallback private void roleResult(PluginCall call, ActivityResult result) { if (!refused(call)) call.resolve(statusObject()); }

 /** One bounded provider read on the reader thread, published only if nothing changed meanwhile. */
 protected interface Read { JSObject read(android.os.CancellationSignal cancel) throws Exception; }
 /**
  * Runs a read that needs the permission alias, cancelled on background, lock, screen-off and
  * permission change, and fenced again on the main thread before the result is published.
  */
 protected final void fencedRead(PluginCall call, String alias, String noun, Read read) {
  if (getPermissionState(alias) != PermissionState.GRANTED) { call.reject(noun + " access is not granted", "permission-required"); return; }
  final long access = generation.get();
  final android.os.CancellationSignal cancel = new android.os.CancellationSignal(); reads.add(cancel);
  try {
   reader.execute(() -> {
    try {
     if (!current(access, cancel, alias)) throw new SecurityException();
     JSObject value = read.read(cancel);
     main.post(() -> {
      if (!current(access, cancel, alias)) call.reject(noun + " access changed. Refresh after unlocking.", "unavailable");
      else call.resolve(value);
     });
    } catch (Exception unreadable) { call.reject(noun + " could not be read. Check access and refresh.", "unavailable"); }
    finally { reads.remove(cancel); }
   });
  } catch (java.util.concurrent.RejectedExecutionException gone) { reads.remove(cancel); call.reject(CLOSED); }
 }
 private boolean current(long access, android.os.CancellationSignal cancel, String alias) {
  return !cancel.isCanceled() && access == generation.get() && unlockedForeground() && admitted() && getPermissionState(alias) == PermissionState.GRANTED;
 }

 private JSObject handoff(String status, String target, String handler, String message) {
  JSObject value = new JSObject();
  value.put("status", status); value.put("target", target); value.put("handler", handler == null ? JSONObject.NULL : handler); value.put("message", message);
  return value;
 }
 private void open(PluginCall call, Intent intent, String target, String done) {
  if (refused(call)) return;
  ResolveInfo handler = getContext().getPackageManager().resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
  if (handler == null || handler.activityInfo == null) { call.resolve(handoff("unavailable", target, null, "No app on this phone handles this.")); return; }
  try {
   getActivity().startActivity(intent);
   String name = "android".equals(handler.activityInfo.packageName) ? null : handler.activityInfo.packageName;
   call.resolve(handoff("handed-off", target, name, done));
  } catch (ActivityNotFoundException missing) {
   call.resolve(handoff("unavailable", target, null, "No app on this phone handles this."));
  } catch (RuntimeException failure) {
   call.resolve(handoff("failed", target, null, "The app could not be opened. Nothing was sent or dialed."));
  }
 }

 /** Opens the user's dialer with this number. The call is placed, or not, there; emergency numbers stay with the system. */
 @PluginMethod public void dial(PluginCall call) {
  if (refused(call)) return;
  String number = call.getString("number", "");
  if (number == null || !NUMBER.matcher(number).matches()) { call.reject("Not a dialable phone number", "invalid"); return; }
  open(call, new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)), "dialer",
    "Your phone app is open with the number. Place the call there; this app does not know whether it connects.");
 }

 /** Opens the user's SMS app with the reviewed recipients and text. A handoff cannot choose the SIM, so a SIM choice is refused. */
 @PluginMethod public void composeSms(PluginCall call) {
  if (refused(call)) return;
  if (call.getData().has("subscriptionId")) { call.reject("Choose the SIM in your messaging app", "invalid"); return; }
  JSArray recipients = call.getArray("recipients");
  String body = call.getString("body", "");
  if (recipients == null || recipients.length() < 1 || recipients.length() > MAX_RECIPIENTS || body == null || body.trim().isEmpty() || body.length() > MAX_BODY) { call.reject("Invalid message", "invalid"); return; }
  StringBuilder to = new StringBuilder();
  for (int index = 0; index < recipients.length(); index++) {
   String number = recipients.optString(index, "");
   if (!NUMBER.matcher(number).matches()) { call.reject("Invalid recipient", "invalid"); return; }
   if (to.length() > 0) to.append(';');
   to.append(number);
  }
  Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", to.toString(), null)).putExtra("sms_body", body);
  open(call, intent, "sms", "Your messaging app is open with the reviewed text. Send it there; nothing has been sent.");
 }

 // ---- SMS/MMS provider reads -------------------------------------------------------------------

 private static long before(PluginCall call) { return date(call, "before"); }
 /** A date option in milliseconds: 0 when absent, -1 when it is not a positive whole number. */
 private static long date(PluginCall call, String key) {
  Object raw = call.getData().opt(key);
  if (raw == null || raw == JSONObject.NULL) return 0;
  if (!(raw instanceof Number)) return -1;
  double value = ((Number) raw).doubleValue();
  return Double.isFinite(value) && value == Math.rint(value) && value > 0 && value < 9.0e15 ? (long) value : -1;
 }

 /** Conversation threads, newest first. */
 @PluginMethod public void listThreads(PluginCall call) {
  if (refused(call)) return;
  Integer limit = call.getInt("limit", 20); long before = before(call);
  if (limit == null || limit < 1 || limit > SmsRecords.MAX_THREADS || before < 0) { call.reject("Invalid thread page", "invalid"); return; }
  final SmsPageCursor cursor;
  try { cursor = SmsPageCursor.parse(call.getString("cursor"), true); } catch (RuntimeException invalid) { call.reject("Invalid thread cursor", "invalid"); return; }
  fencedRead(call, "sms", "Messages", cancel -> SmsProviderReader.threads(getContext(), limit, before, cursor, cancel));
 }

 /** Messages of one thread, SMS and MMS, newest first. */
 @PluginMethod public void listMessages(PluginCall call) {
  if (refused(call)) return;
  Integer limit = call.getInt("limit", 25); long before = before(call); long thread = SmsRecords.threadRow(call.getString("threadId", ""));
  if (limit == null || limit < 1 || limit > SmsRecords.MAX_MESSAGES || before < 0 || thread < 1) { call.reject("Invalid message page", "invalid"); return; }
  final SmsPageCursor cursor;
  try { cursor = SmsPageCursor.parse(call.getString("cursor"), false); } catch (RuntimeException invalid) { call.reject("Invalid message cursor", "invalid"); return; }
  fencedRead(call, "sms", "Messages", cancel -> SmsProviderReader.messages(getContext(), thread, limit, before, cursor, cancel));
 }

 /**
  * Marks a conversation's received messages read, up to the newest one the owner has on screen
  * ({@code throughDate}, milliseconds), and removes its notice. Keeping read state is the default SMS
  * app's job and Android accepts the write only from that app: elsewhere nothing changes and the
  * answer says so. Same admission, permission and fence as the reads; no content is returned.
  */
 @PluginMethod public void markThreadRead(PluginCall call) {
  if (refused(call)) return;
  long thread = SmsRecords.threadRow(call.getString("threadId", "")), through = date(call, "throughDate");
  if (thread < 1 || through <= 0) { call.reject("Invalid conversation", "invalid"); return; }
  fencedRead(call, "sms", "Messages", cancel -> {
   JSObject value = new JSObject();
   boolean holder = MmsStore.isDefaultSmsApp(getContext());
   value.put("defaultSmsApp", holder);
   value.put("updated", holder ? MmsStore.markThreadRead(getContext(), thread, through) : 0);
   return value;
  });
 }

 // ---- Incoming/outgoing change observation ----------------------------------------------------

 private boolean observeWanted, observing;
 private long observedSequence;
 private final Runnable emitChange = () -> {
  if (!observing || !unlockedForeground() || !admitted() || getPermissionState("sms") != PermissionState.GRANTED) return;
  JSObject value = new JSObject(); value.put("sequence", ++observedSequence);
  // No content leaves here: the renderer re-reads a bounded page.
  notifyListeners("messagesChanged", value);
  SmsTelephony.reconcileLater(getContext(), config);
 };
 private final android.database.ContentObserver providerObserver = new android.database.ContentObserver(main) {
  // Coalesced: at most one notice per 750 ms however many rows change.
  @Override public void onChange(boolean self) { main.removeCallbacks(emitChange); main.postDelayed(emitChange, 750); }
 };
 private void startObserving() {
  if (observing) return;
  android.content.ContentResolver resolver = getContext().getContentResolver();
  try {
   resolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, providerObserver);
   resolver.registerContentObserver(Telephony.Mms.CONTENT_URI, true, providerObserver);
   resolver.registerContentObserver(Telephony.MmsSms.CONTENT_URI, true, providerObserver);
   observing = true;
  } catch (RuntimeException refusedObserver) { resolver.unregisterContentObserver(providerObserver); observing = false; }
 }
 private void stopObserving() {
  main.removeCallbacks(emitChange);
  if (!observing) return;
  observing = false;
  getContext().getContentResolver().unregisterContentObserver(providerObserver);
 }
 private void resumeObserving() {
  if (!observeWanted || !admitted() || getPermissionState("sms") != PermissionState.GRANTED || !unlockedForeground()) return;
  startObserving();
  main.removeCallbacks(emitChange); main.post(emitChange);
 }

 /** Starts or stops content-free change notices ("messagesChanged") while the host is unlocked in the foreground. */
 @PluginMethod public void observeMessages(PluginCall call) {
  if (refused(call)) return;
  Boolean enabled = call.getBoolean("enabled", false);
  if (enabled == null || !enabled) { observeWanted = false; stopObserving(); call.resolve(); return; }
  if (getPermissionState("sms") != PermissionState.GRANTED) { call.reject("Messages access is not granted", "permission-required"); return; }
  observeWanted = true; startObserving();
  if (!observing) { observeWanted = false; call.reject("Messages could not be observed", "unavailable"); return; }
  call.resolve();
 }

 // ---- Reviewed native sends ------------------------------------------------------------------

 private android.app.AlertDialog review;
 private PluginCall reviewCall;
 private Runnable reviewCancelled;
 private void cancelReview() {
  if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) { main.post(this::cancelReview); return; }
  android.app.AlertDialog open = review; Runnable cancelled = reviewCancelled;
  review = null; reviewCall = null; reviewCancelled = null;
  if (open != null) { open.setOnDismissListener(null); open.dismiss(); }
  if (cancelled != null) cancelled.run();
 }
 /** Why a direct send is not permitted now, or null. Nothing is sent when this is non-null. */
 private String sendBlocker(int subscriptionId) {
  TelephonyManager telephony = getContext().getSystemService(TelephonyManager.class);
  if (telephony == null || !telephony.isSmsCapable()) return "This phone cannot send text messages.";
  if (getPermissionState("sendSms") != PermissionState.GRANTED) return "This app may not send texts. Use your messaging app.";
  if (getPermissionState("phoneState") != PermissionState.GRANTED) return "Allow phone-state access so the SIM can be confirmed.";
  return activeSubscription(subscriptionId) == null ? "That SIM is not active now. Review the message again." : null;
 }
 private SubscriptionInfo activeSubscription(int id) {
  List<SubscriptionInfo> active = SmsTelephony.activeSubscriptions(getContext(), config);
  if (active != null) for (SubscriptionInfo info : active) if (info != null && info.getSubscriptionId() == id && info.getSimSlotIndex() >= 0) return info;
  return null;
 }
 private static String[] numbers(JSArray recipients) {
  if (recipients == null) return null;
  String[] out = new String[recipients.length()];
  for (int i = 0; i < out.length; i++) { Object value = recipients.opt(i); if (!(value instanceof String)) return null; out[i] = (String) value; }
  return out;
 }

 /**
  * Sends a reviewed text natively. The operation ID is the caller's idempotency key: a repeated ID
  * returns its journaled result and never sends again. The owner confirms the exact recipients, text,
  * SIM and part count in the host's native dialog on the unlocked phone; declining records "cancelled".
  * The result is the shared `SmsSendResult`; "submitted" proves only that Android accepted the request.
  */
 @PluginMethod public void sendSms(PluginCall call) {
  if (refused(call)) return;
  main.post(() -> reviewSmsOnMain(call));
 }
 private void reviewSmsOnMain(PluginCall call) {
  if (refused(call)) return;
  String operationId = call.getString("operationId"), body = call.getString("body");
  String[] recipients = numbers(call.getArray("recipients"));
  Object rawSubscription = call.getData().opt("subscriptionId");
  int subscriptionId = rawSubscription instanceof Integer ? (Integer) rawSubscription : -1;
  try { SmsSendJournal.validate(operationId, recipients, body, subscriptionId); }
  catch (IllegalArgumentException invalid) { call.reject("Invalid reviewed message", "invalid"); return; }
  final SmsSendJournal journal;
  final SmsSendJournal.Record existing;
  try {
   journal = SmsTelephony.journal(getContext(), config);
   existing = journal.existing(operationId, SmsSendJournal.sha256(SmsSendJournal.bindingText(recipients, body, subscriptionId)));
  } catch (SmsSendJournal.Expired expired) { call.reject("This request is too old to read back. Nothing was sent again.", "expired"); return; }
  catch (IllegalStateException reused) { call.reject("This request was already used for a different message. Nothing was sent.", "invalid"); return; }
  catch (Exception unreadable) { call.reject("The send record could not be read. Nothing was sent.", "unavailable"); return; }
  if (existing != null) { call.resolve(SmsTelephony.result(existing)); return; }
  if (review != null) { call.reject("Another message is waiting for review", "busy"); return; }
  final long now = System.currentTimeMillis(), boot = SmsTelephony.boot(getContext());
  String blocked = sendBlocker(subscriptionId);
  if (blocked != null) { decide(call, journal, operationId, recipients, body, subscriptionId, "denied", now, boot); return; }
  final ArrayList<String> parts;
  try { parts = SmsTelephony.manager(getContext(), subscriptionId).divideMessage(body); }
  catch (RuntimeException unavailable) { decide(call, journal, operationId, recipients, body, subscriptionId, "denied", now, boot); return; }
  if (parts == null || parts.isEmpty() || parts.size() > SmsSendJournal.MAX_PARTS_PER_RECIPIENT) { call.reject("This text is too long to send as SMS. Shorten it and review again.", "too-long"); return; }
  SubscriptionInfo sim = activeSubscription(subscriptionId);
  if (sim == null) { decide(call, journal, operationId, recipients, body, subscriptionId, "denied", now, boot); return; }
  StringBuilder message = new StringBuilder();
  message.append("To: ").append(String.join(", ", recipients)).append('\n');
  message.append("From: SIM ").append(sim.getSimSlotIndex() + 1).append(" · ").append(clip(sim.getDisplayName())).append(" (").append(clip(sim.getCarrierName())).append(")\n");
  if (recipients.length > 1) message.append("Each recipient gets a separate text, not a group message.\n");
  if (parts.size() > 1) message.append("Sent as ").append(parts.size()).append(" linked texts per recipient.\n");
  message.append("Carrier charges may apply.\n\n").append(body);
  final String[] to = recipients; final int sub = subscriptionId;
  final int reviewedSlot = sim.getSimSlotIndex(), reviewedCarrier = sim.getCarrierId();
  reviewCall = call;
  reviewCancelled = () -> decide(call, journal, operationId, to, body, sub, "cancelled", now, boot);
  try {
   review = new android.app.AlertDialog.Builder(getActivity())
    .setTitle(recipients.length > 1 ? "Send " + recipients.length + " text messages?" : "Send text message?")
    .setMessage(message.toString())
    .setNegativeButton("Cancel", null)
    .setPositiveButton("Send", (dialog, which) -> {
     if (reviewCall != call) return;
     review = null; reviewCall = null; reviewCancelled = null;
     // Recheck everything at the moment of the owner's decision.
     if (!admitted() || !unlockedForeground() || sendBlocker(sub) != null) { decide(call, journal, operationId, to, body, sub, "denied", now, boot); return; }
     try { call.resolve(SmsTelephony.result(SmsTelephony.dispatch(getContext(), config, journal, operationId, to, body, sub, parts, () -> {
      SubscriptionInfo current = activeSubscription(sub);
      if (!admitted() || !unlockedForeground() || sendBlocker(sub) != null || current == null || current.getSimSlotIndex() != reviewedSlot || current.getCarrierId() != reviewedCarrier) throw new IllegalStateException("Reviewed SIM or access changed");
     }))); }
     catch (Exception unrecorded) {
      SmsSendJournal.Record record = journal.get(operationId);
      if (record != null) call.resolve(SmsTelephony.result(record));
      // Nothing reached Android (access or the reviewed SIM changed, or the journal refused it):
      // close the ID as denied so it is never sent later; decide() rejects if even that cannot be recorded.
      else decide(call, journal, operationId, to, body, sub, "denied", now, boot);
     }
    })
    .create();
   review.setOnDismissListener(dialog -> { if (reviewCall == call) cancelReview(); });
   if (review.getWindow() != null) review.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
   review.show();
   // An overlay must not be able to steer the owner's Send tap.
   android.widget.Button send = review.getButton(android.content.DialogInterface.BUTTON_POSITIVE);
   if (send != null) send.setFilterTouchesWhenObscured(true);
  } catch (RuntimeException gone) { review = null; reviewCall = null; reviewCancelled = null; call.reject(CLOSED); }
 }
 private void decide(PluginCall call, SmsSendJournal journal, String operationId, String[] recipients, String body, int subscriptionId, String decision, long now, long boot) {
  try { call.resolve(SmsTelephony.result(journal.decide(operationId, recipients, body, subscriptionId, decision, now, boot))); }
  catch (Exception unrecorded) { call.reject("Nothing was sent.", "unavailable"); }
 }

 /** An invalidated agent approval can cancel only its own outstanding native dialog. */
 @PluginMethod public void cancelSmsReview(PluginCall call) {
  if (refused(call)) return;
  final String operationId = call.getString("operationId", "");
  main.post(() -> {
   if (reviewCall != null && operationId.equals(reviewCall.getString("operationId"))) cancelReview();
   call.resolve();
  });
 }

 /** Bounded receipt metadata only; drafts and phone numbers never enter this history response. */
 @PluginMethod public void smsSendHistory(PluginCall call) {
  if (refused(call)) return;
  try {
   JSArray rows = new JSArray();
   for (SmsSendJournal.Record record : SmsTelephony.journal(getContext(), config).recent(SmsSendJournal.MAX_RECORDS)) rows.put(SmsTelephony.result(record));
   JSObject result = new JSObject(); result.put("receipts", rows); call.resolve(result);
  } catch (Exception unreadable) { call.reject("The send history could not be read.", "unavailable"); }
 }

 /** The journaled result of a reviewed send. Reading never sends. */
 @PluginMethod public void smsSendResult(PluginCall call) {
  if (refused(call)) return;
  String operationId = call.getString("operationId", "");
  if (operationId == null || !SmsSendJournal.OPERATION.matcher(operationId).matches()) { call.reject("Invalid send", "invalid"); return; }
  try {
   SmsSendJournal.Record record = SmsTelephony.journal(getContext(), config).get(operationId);
   if (record == null) call.reject("No send with this ID", "not-found"); else call.resolve(SmsTelephony.result(record));
  } catch (Exception unreadable) { call.reject("The send record could not be read.", "unavailable"); }
 }

 @Override protected void handleOnDestroy() { closed = true; invalidateReads(); SmsTelephony.stopListening(sendListener); getContext().unregisterReceiver(screenOff); reader.shutdown(); super.handleOnDestroy(); }
}

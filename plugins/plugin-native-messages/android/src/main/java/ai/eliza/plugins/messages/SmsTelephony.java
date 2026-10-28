package ai.eliza.plugins.messages;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Settings;
import android.provider.Telephony;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Reviewed native SMS sends and their evidence for hosts admitted to the AOSP telephony profile.
 *
 * A send is journaled in {@link SmsSendJournal} before the first platform call and dispatched through
 * SmsManager for the reviewed subscription with one immutable, package-explicit sent and delivery
 * PendingIntent per part, addressed to the host's receiver. "sent" comes only from RESULT_OK sent
 * callbacks and "delivered" only from delivery reports whose provider row reads complete. Nothing is
 * ever resent automatically and the journal never stores the body, only its hash. The message itself
 * is in the system SMS provider, as any sent text is: Android writes that row, except for the default
 * SMS app, which writes its own (see {@link #dispatch}); delivery is never claimed for those rows.
 *
 * Every entry point is reached only from the host's {@link TelephonyPlugin} or its callback receiver,
 * both of which require {@link SmsTelephonyConfiguration#admission}.
 */
public final class SmsTelephony {
 private SmsTelephony() {}
 /** Journal writes, callbacks and reconciliation run here, one at a time. */
 public static final ExecutorService WORK = Executors.newSingleThreadExecutor();

 public interface Listener { void sendUpdated(String operationId); }
 private static volatile Listener listener;
 public static void listen(Listener value) { listener = value; }
 public static void stopListening(Listener value) { if (listener == value) listener = null; }
 static void updated(String operationId) { Listener current = listener; if (current != null) current.sendUpdated(operationId); }

 private static final Map<String, SmsSendJournal> JOURNALS = new HashMap<>();
 /** The process's journal for this host; an interrupted dispatch from an earlier process is reconciled to unknown on first load. */
 public static synchronized SmsSendJournal journal(Context context, SmsTelephonyConfiguration config) throws IOException {
  SmsSendJournal journal = JOURNALS.get(config.journalKey());
  if (journal != null) return journal;
  final SmsTelephonyConfiguration.JournalStore store;
  try { store = config.store.open(context); } catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
  final File legacy = config.legacyJournalFile == null ? null : new File(context.getNoBackupFilesDir(), config.legacyJournalFile);
  final String slot = config.journalSlot;
  SmsSendJournal loaded = new SmsSendJournal(new SmsSendJournal.Storage() {
   public String read() throws IOException {
    try {
     String encrypted = store.read(slot);
     // The encrypted ledger is authoritative once written; a leftover plaintext copy is only removed.
     if (encrypted != null) { removeLegacy(legacy); return new JSONObject(encrypted).getString("journal"); }
     if (legacy == null || !legacy.exists()) return null;
     String previous = new String(java.nio.file.Files.readAllBytes(legacy.toPath()), java.nio.charset.StandardCharsets.UTF_8);
     // Encrypt before removing the old file; an interrupted migration never loses replay protection.
     write(previous);
     return previous;
    } catch (IOException failure) { throw failure; }
    catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
   }
   public void write(String value) throws IOException {
    try { store.write(slot, new JSONObject().put("journal", value).toString()); }
    catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
    // After a durable encrypted write, failing to delete the old copy must not read as an unrecorded send.
    removeLegacy(legacy);
   }
  }, config.retiredNamespace);
  loaded.reconcile(boot(context), false);
  JOURNALS.put(config.journalKey(), loaded);
  return loaded;
 }
 private static void removeLegacy(File legacy) { if (legacy != null && legacy.exists() && !legacy.delete()) android.util.Log.w("SmsTelephony", "Legacy plaintext SMS journal could not be removed yet"); }
 public static long boot(Context context) {
  try { return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1); }
  catch (RuntimeException unreadable) { return -1; }
 }
 static boolean granted(Context context, String permission) { return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }

 /** Active SIM subscriptions, or null when the profile, the permission or Android refuses the read: never an empty list in its place. */
 public static List<SubscriptionInfo> activeSubscriptions(Context context, SmsTelephonyConfiguration config) {
  if (!config.admission.admitted(context) || !granted(context, Manifest.permission.READ_PHONE_STATE)) return null;
  SubscriptionManager manager = context.getSystemService(SubscriptionManager.class);
  if (manager == null) return null;
  try {
   List<SubscriptionInfo> active = manager.getActiveSubscriptionInfoList();
   return active == null ? Collections.emptyList() : active;
  } catch (SecurityException denied) { return null; }
 }

 // ---- Sends -----------------------------------------------------------------------------------

 static SmsManager manager(Context context, int subscriptionId) {
  if (android.os.Build.VERSION.SDK_INT >= 31) {
   SmsManager base = context.getSystemService(SmsManager.class);
   if (base == null) throw new IllegalStateException("no SmsManager");
   return base.createForSubscriptionId(subscriptionId);
  }
  return SmsManager.getSmsManagerForSubscriptionId(subscriptionId);
 }

 private static PendingIntent callback(Context context, SmsTelephonyConfiguration config, String action, String operationId, int index) {
  // Explicit component and package, immutable and one-shot: the framework can only report the result code.
  Intent intent = new Intent(action).setClass(context, config.receiverClass).setPackage(context.getPackageName())
   .setData(Uri.fromParts(config.callbackScheme, operationId + "/" + index, null))
   .putExtra(config.operationExtra, operationId).putExtra(config.indexExtra, index);
  return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT);
 }

 /** Rechecks the reviewed conditions immediately before each platform call. Throwing stops the dispatch. */
 public interface DispatchGuard { void check(); }
 /**
  * Journals the reviewed send, then submits one message per recipient on the reviewed subscription,
  * divided by the platform. A platform call that throws ends the dispatch as unknown: earlier
  * recipients may have been submitted, so nothing is attempted again automatically.
  *
  * Android writes the provider row of a send for every app except the default SMS app. While this
  * host holds the SMS role it therefore stores each recipient's message in the outbox itself, just
  * before that recipient's platform call, and its sent callbacks settle the row
  * ({@link #handleCallback}).
  */
 static SmsSendJournal.Record dispatch(Context context, SmsTelephonyConfiguration config, SmsSendJournal journal, String operationId, String[] recipients, String body, int subscriptionId, ArrayList<String> parts, DispatchGuard guard) throws IOException {
  guard.check();
  SmsManager manager = manager(context, subscriptionId);
  int[] counts = new int[recipients.length];
  java.util.Arrays.fill(counts, parts.size());
  SmsSendJournal.Record record = journal.beginDispatch(operationId, recipients, body, subscriptionId, counts, System.currentTimeMillis(), boot(context));
  final boolean ownsRows = MmsStore.isDefaultSmsApp(context);
  boolean returned = true;
  try {
   int index = 0;
   for (int position = 0; position < recipients.length; position++) {
    String recipient = recipients[position];
    guard.check();
    if (ownsRows) storeOwnRow(context, journal, record, position, body, subscriptionId);
    ArrayList<PendingIntent> sent = new ArrayList<>(), delivered = new ArrayList<>();
    for (int part = 0; part < parts.size(); part++, index++) { sent.add(callback(context, config, config.sentAction, operationId, index)); delivered.add(callback(context, config, config.deliveredAction, operationId, index)); }
    if (parts.size() == 1) manager.sendTextMessage(recipient, null, parts.get(0), sent.get(0), delivered.get(0));
    else manager.sendMultipartTextMessage(recipient, null, parts, sent, delivered);
   }
  } catch (RuntimeException failed) {
   returned = false;
  } finally {
   journal.endDispatch(operationId, returned);
  }
  return record;
 }

 /**
  * The default SMS app's own outbox row for one recipient, recorded in the journal before the platform
  * call so that recipient's sent callbacks find it. A refused write never stops the reviewed send, and
  * never ends it as unknown: the journal keeps the receipt either way, and an unrecorded row can still
  * be attributed later by creator, address, time window and body hash.
  */
 private static void storeOwnRow(Context context, SmsSendJournal journal, SmsSendJournal.Record record, int recipient, String body, int subscriptionId) {
  long row;
  try { row = MmsStore.persistOutgoingSms(context, record.recipients[recipient], body, subscriptionId, record.createdAt); }
  catch (RuntimeException refused) { android.util.Log.w("SmsTelephony", "Outgoing SMS was not stored in the provider"); return; }
  try { journal.providerRow(record.operationId, recipient, row); }
  catch (IOException | RuntimeException unrecorded) { android.util.Log.w("SmsTelephony", "Outgoing SMS row was not recorded in the journal"); }
 }

 /** Moves the default SMS app's own row for this part's recipient out of the outbox once its sent callbacks decide it. */
 private static void settleOwnRow(Context context, SmsSendJournal journal, String operationId, int index) {
  long[] settled = journal.settledRow(operationId, index);
  if (settled == null || !MmsStore.isDefaultSmsApp(context)) return;
  try { MmsStore.settleOutgoingSms(context, settled[0], (int) settled[1]); }
  catch (RuntimeException unwritable) { /* The journal keeps the evidence; the row stays queued. */ }
 }

 /** The shared contract's `SmsSendResult`, exactly its fields. */
 public static JSObject result(SmsSendJournal.Record record) {
  JSObject value = new JSObject();
  value.put("kind", "sms-send");
  value.put("operationId", record.operationId);
  value.put("subscriptionId", record.subscriptionId);
  value.put("bindingHash", record.bindingHash);
  value.put("status", record.status());
  JSArray parts = new JSArray();
  if (record.decision == null) for (int i = 0; i < record.parts(); i++) {
   JSObject part = new JSObject();
   part.put("index", i); part.put("recipientIndex", record.recipientOf(i)); part.put("partIndex", record.partOf(i));
   part.put("sent", state(record.sent[i])); part.put("delivery", state(record.delivery[i]));
   parts.put(part);
  }
  value.put("parts", parts);
  value.put("createdAt", record.createdAt);
  return value;
 }
 private static String state(char value) { return value == SmsSendJournal.SUCCESS ? "success" : value == SmsSendJournal.FAILED ? "failed" : "unknown"; }

 /**
  * Handles one sent or delivery callback in the host's manifest receiver, so evidence reaches the
  * journal even after the app's process was stopped. Ignored unless the profile admits this install.
  * "sent" is recorded only from a callback whose result is Activity.RESULT_OK; a delivery callback only
  * records that a report arrived, and its outcome is the provider status the platform wrote from it.
  */
 public static void handleCallback(BroadcastReceiver receiver, Context context, Intent intent, SmsTelephonyConfiguration config) {
  if (intent == null || !config.admission.admitted(context)) return;
  String action = intent.getAction(), operation = intent.getStringExtra(config.operationExtra);
  int index = intent.getIntExtra(config.indexExtra, -1);
  boolean sent = config.sentAction.equals(action), delivered = config.deliveredAction.equals(action);
  if ((!sent && !delivered) || operation == null || !SmsSendJournal.OPERATION.matcher(operation).matches() || index < 0) return;
  final boolean ok = receiver.getResultCode() == Activity.RESULT_OK;
  final Context app = context.getApplicationContext();
  final BroadcastReceiver.PendingResult pending = receiver.goAsync();
  try {
   WORK.execute(() -> {
    try {
     SmsSendJournal journal = journal(app, config);
     boolean changed = sent ? journal.sentResult(operation, index, ok) : journal.deliveryReported(operation, index);
     if (sent) settleOwnRow(app, journal, operation, index);
     Set<String> reconciled = reconcile(app, config);
     if (changed || reconciled.contains(operation)) updated(operation);
     for (String other : reconciled) if (!other.equals(operation)) updated(other);
    } catch (Exception unrecorded) {
     // The journal keeps its last durable evidence; the send stays unconfirmed rather than guessed.
    } finally {
     if (pending != null) pending.finish();
    }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { if (pending != null) pending.finish(); }
 }

 /** Startup and observer reconciliation on {@link #WORK}; publishes changed operations to the listener. */
 public static void reconcileLater(Context context, SmsTelephonyConfiguration config) {
  final Context app = context.getApplicationContext();
  try { WORK.execute(() -> { for (String id : reconcile(app, config)) updated(id); }); } catch (java.util.concurrent.RejectedExecutionException ignored) { }
 }

 /**
  * Matches each sent recipient to the provider row the platform wrote (address, time window and body
  * hash; READ_SMS required) and applies that row's delivery status to parts whose delivery report
  * arrived. Returns the operation IDs that changed.
  */
 static Set<String> reconcile(Context context, SmsTelephonyConfiguration config) {
  Set<String> changed = new HashSet<>();
  try {
   SmsSendJournal journal = journal(context, config);
   if (journal.reconcile(boot(context), true)) for (SmsSendJournal.Record r : journal.recent(SmsSendJournal.MAX_RECORDS)) changed.add(r.operationId);
   if (!granted(context, Manifest.permission.READ_SMS)) return changed;
   ContentResolver resolver = context.getContentResolver();
   Set<Long> claimed = new HashSet<>();
   for (SmsSendJournal.Record r : journal.recent(SmsSendJournal.MAX_RECORDS)) for (long row : r.providerRow) if (row > 0) claimed.add(row);
   for (SmsSendJournal.Record record : journal.open(boot(context), System.currentTimeMillis())) {
    for (int recipient = 0; recipient < record.recipients.length; recipient++) {
     int first = record.firstPart(recipient), count = record.partsPerRecipient[recipient];
     boolean allSent = true, reported = false;
     for (int i = first; i < first + count; i++) { allSent &= record.sent[i] == SmsSendJournal.SUCCESS; reported |= record.reported[i] && record.delivery[i] == SmsSendJournal.UNKNOWN; }
     if (!allSent) continue;
     if (journal.ambiguousProviderOwner(record, recipient, ROW_WINDOW_MS)) continue;
     if (record.providerRow[recipient] == 0) {
      long row = findRow(resolver, context.getPackageName(), record, recipient, claimed);
      if (row > 0) { journal.providerRow(record.operationId, recipient, row); claimed.add(row); }
     }
     if (!reported || record.providerRow[recipient] == 0) continue;
     try (Cursor c = resolver.query(Uri.withAppendedPath(Telephony.Sms.CONTENT_URI, Long.toString(record.providerRow[recipient])), new String[] { Telephony.Sms.STATUS }, null, null, null)) {
      if (c != null && c.moveToFirst() && journal.providerStatus(record.operationId, recipient, SmsProviderReader.intAt(c, Telephony.Sms.STATUS, SmsSendJournal.STATUS_NONE))) changed.add(record.operationId);
     }
    }
   }
  } catch (IOException | RuntimeException unreadable) {
   // Evidence stays as recorded; nothing is inferred from a failed read.
  }
  return changed;
 }
 /**
  * The platform writes the row for a non-default app's send with that app as creator, after the
  * journal entry (same wall clock) and within moments of the call. Rows written by another app or by
  * the owner, and rows from before the journal entry, are never matched, even with the same text.
  */
 private static final long ROW_WINDOW_MS = 10 * 60_000L;
 private static long findRow(ContentResolver resolver, String creator, SmsSendJournal.Record record, int recipient, Set<Long> claimed) {
  String where = Telephony.Sms.ADDRESS + " = ? AND " + Telephony.Sms.CREATOR + " = ? AND " + Telephony.Sms.DATE + " >= ? AND " + Telephony.Sms.DATE + " <= ? AND " + Telephony.Sms.TYPE + " IN (2,4,5,6) AND " + Telephony.Sms.SUBSCRIPTION_ID + " = ?";
  try (Cursor c = resolver.query(Telephony.Sms.CONTENT_URI, new String[] { Telephony.Sms._ID, Telephony.Sms.BODY }, where,
    new String[] { record.recipients[recipient], creator, Long.toString(record.createdAt), Long.toString(record.createdAt + ROW_WINDOW_MS), Integer.toString(record.subscriptionId) }, Telephony.Sms._ID + " ASC")) {
   SmsSendJournal.ProviderMatch match = new SmsSendJournal.ProviderMatch();
   while (c != null && c.moveToNext()) {
    long id = SmsProviderReader.longAt(c, Telephony.Sms._ID); String body = SmsProviderReader.textAt(c, Telephony.Sms.BODY);
    if (!match.visit(id, id > 0 && body != null && SmsSendJournal.sha256(body).equals(record.bodyHash), claimed.contains(id))) return 0;
   }
   return match.result();
  }
 }
}

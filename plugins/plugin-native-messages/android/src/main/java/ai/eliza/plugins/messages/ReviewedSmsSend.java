package ai.eliza.plugins.messages;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SmsManager;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import kotlin.Unit;
import org.json.JSONObject;

/**
 * The narrow public entry point for a host's own native components (a review screen, a quick-reply
 * service) to send one `sms.send.v1` operation through the shared reviewed send. It does not review
 * anything itself: the caller is the review, and calls this only after the owner's decision (or, for a
 * user-initiated quick reply, the owner's own choice in the call screen).
 *
 * The send is journaled in {@link SmsSendJournal} before the first SmsManager call and bound to the
 * exact recipients, text and SIM. A repeated operation ID only reads its record, so pressing Send
 * twice, a retried worker or a redelivered intent never sends twice. Sent receipts are one
 * package-private, one-shot PendingIntent per part ({@link SmsSendRequest}); "sent" comes only from
 * RESULT_OK receipts, and a receipt that does not arrive within {@link #RECEIPT_TIMEOUT_MS}, or that
 * died with the process, makes the send "unknown". Nothing is ever resent automatically. While the
 * host is the default SMS app it stores each recipient's message in the outbox before that
 * recipient's platform call and the receipts settle the row; otherwise Android writes the row. Hosts
 * never write sent-box rows themselves.
 *
 * Unlike {@link SmsTelephony}, receipts are held in process, so this needs no manifest receiver and
 * no AOSP admission: a host on any image can use it for its own native sends. Delivery is not
 * requested here and is never claimed.
 */
public final class ReviewedSmsSend {
 private ReviewedSmsSend() {}

 /** A sent receipt that has not arrived by then makes the send "unknown". */
 public static final long RECEIPT_TIMEOUT_MS = 60_000;
 /** Nothing reached Android and no record was made (for example the journal is unavailable). */
 public static final String NOT_SENT = ReviewedSmsSendCore.NOT_SENT;

 /** The final status, on the main thread: a `sms.send.v1` status (cancelled is never produced here) or {@link #NOT_SENT}. */
 public interface Callback { void finished(String status); }

 /**
  * The host's journal identity. Migration-sensitive like {@link SmsTelephonyConfiguration}: keep the
  * slot and namespace once shipped. The slot must differ from any {@link SmsTelephonyConfiguration}
  * slot of the same host, whose receipts arrive through its manifest receiver instead.
  */
 public static final class Host {
  final String journalSlot, retiredNamespace;
  final SmsTelephonyConfiguration.JournalStoreFactory store;
  public Host(String journalSlot, String retiredNamespace, SmsTelephonyConfiguration.JournalStoreFactory store) {
   if (journalSlot == null || !journalSlot.matches("[A-Za-z0-9][A-Za-z0-9:._-]{0,127}")
     || retiredNamespace == null || !retiredNamespace.matches("[a-z0-9][a-z0-9._:-]{0,63}"))
    throw new IllegalArgumentException("Invalid reviewed SMS host");
   this.journalSlot = journalSlot; this.retiredNamespace = retiredNamespace; this.store = java.util.Objects.requireNonNull(store);
  }
  String key() { return journalSlot + "\u0000" + retiredNamespace; }
 }

 private static final Map<String, SmsSendJournal> JOURNALS = new HashMap<>();
 private static final Handler MAIN = new Handler(Looper.getMainLooper());

 /**
  * The process's journal for this host. On first load in a process, an interrupted dispatch and every
  * send still waiting for receipts become "unknown": their in-process receivers are gone.
  */
 static synchronized SmsSendJournal journal(Context context, Host host) throws IOException {
  SmsSendJournal journal = JOURNALS.get(host.key());
  if (journal != null) return journal;
  final SmsTelephonyConfiguration.JournalStore store;
  try { store = host.store.open(context); } catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
  final String slot = host.journalSlot;
  SmsSendJournal loaded = new SmsSendJournal(new SmsSendJournal.Storage() {
   public String read() throws IOException {
    try { String saved = store.read(slot); return saved == null ? null : new JSONObject(saved).getString("journal"); }
    catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
   }
   public void write(String value) throws IOException {
    try { store.write(slot, new JSONObject().put("journal", value).toString()); }
    catch (Exception failure) { throw new IOException("SMS journal unavailable", failure); }
   }
  }, host.retiredNamespace);
  loaded.reconcile(SmsTelephony.boot(context), false);
  loaded.allReceiptsLost();
  JOURNALS.put(host.key(), loaded);
  return loaded;
 }

 /**
  * True when this operation ID was ever journaled, so it can never send again. Blocking: call it off
  * the main thread.
  */
 public static boolean known(Context context, Host host, String operationId) throws IOException {
  return journal(context.getApplicationContext(), host).known(operationId);
 }

 /**
  * Sends one reviewed operation, or reads its outcome when the ID was already journaled.
  *
  * @throws IllegalArgumentException when the request does not match `sms.send.v1`; nothing is recorded or sent.
  */
 public static void send(Context context, Host host, String operationId, String[] recipients, String body, int subscriptionId, Callback callback) {
  SmsSendJournal.validate(operationId, recipients, body, subscriptionId);
  final Context app = context.getApplicationContext();
  final String[] to = recipients.clone();
  try {
   SmsTelephony.WORK.execute(() -> {
    final SmsSendJournal journal;
    final ReviewedSmsSendCore.Plan plan;
    try {
     journal = journal(app, host);
     plan = ReviewedSmsSendCore.plan(journal, operationId, to, body, subscriptionId, SmsTelephony.granted(app, Manifest.permission.SEND_SMS),
      () -> SmsTelephony.manager(app, subscriptionId).divideMessage(body), System.currentTimeMillis(), SmsTelephony.boot(app));
    } catch (IOException | RuntimeException refused) {
     android.util.Log.w("ReviewedSmsSend", "Reviewed SMS was not sent: " + refused.getClass().getSimpleName());
     finish(callback, NOT_SENT);
     return;
    }
    if (!plan.dispatch()) { finish(callback, plan.status); return; }
    if (MmsStore.isDefaultSmsApp(app)) for (int recipient = 0; recipient < to.length; recipient++) SmsTelephony.storeOwnRow(app, journal, plan.record, recipient, body, subscriptionId);
    MAIN.post(() -> dispatch(app, journal, operationId, to, new ArrayList<>(plan.parts), subscriptionId, callback));
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { finish(callback, NOT_SENT); }
 }

 /** On the main looper: receipts first, then one platform call per recipient. */
 private static void dispatch(Context app, SmsSendJournal journal, String operationId, String[] recipients, ArrayList<String> parts, int subscriptionId, Callback callback) {
  final int perRecipient = parts.size();
  SmsSendRequest request = new SmsSendRequest(app, perRecipient * recipients.length, RECEIPT_TIMEOUT_MS,
   (index, ok) -> { work(() -> { ReviewedSmsSendCore.receipt(journal, operationId, index, ok); SmsTelephony.settleOwnRow(app, journal, operationId, index); }); return Unit.INSTANCE; },
   outcome -> {
    final boolean lost = outcome instanceof SmsSendRequest.Outcome.Unknown;
    work(() -> {
     String status;
     // An unreadable record still ends the send, as unknown, never as unsent.
     try { status = ReviewedSmsSendCore.settle(journal, operationId, lost); } catch (IOException | RuntimeException unreadable) { status = "unknown"; }
     finish(callback, status);
    });
    return Unit.INSTANCE;
   });
  boolean returned = true;
  try {
   List<PendingIntent> receipts = request.start();
   SmsManager manager = SmsTelephony.manager(app, subscriptionId);
   for (int recipient = 0; recipient < recipients.length; recipient++) {
    ArrayList<PendingIntent> sent = new ArrayList<>(receipts.subList(recipient * perRecipient, (recipient + 1) * perRecipient));
    if (perRecipient == 1) manager.sendTextMessage(recipients[recipient], null, parts.get(0), sent.get(0), null);
    else manager.sendMultipartTextMessage(recipients[recipient], null, parts, sent, null);
   }
  } catch (RuntimeException failed) {
   // Earlier recipients may have been submitted: the send ends unknown and is never attempted again.
   returned = false;
  }
  final boolean all = returned;
  // Queued before any receipt can be handled, so the journal sees the dispatch end first.
  work(() -> ReviewedSmsSendCore.returned(journal, operationId, all));
  if (!all) request.cancel("SMS dispatch interrupted; send status is unknown");
 }

 private interface Step { void run() throws IOException; }
 private static void work(Step step) {
  try {
   SmsTelephony.WORK.execute(() -> {
    try { step.run(); }
    catch (IOException | RuntimeException unrecorded) { android.util.Log.w("ReviewedSmsSend", "Reviewed SMS evidence was not recorded", unrecorded); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { android.util.Log.w("ReviewedSmsSend", "Reviewed SMS evidence was not recorded"); }
 }
 private static void finish(Callback callback, String status) { if (callback != null) MAIN.post(() -> callback.finished(status)); }
}

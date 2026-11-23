package ai.eliza.plugins.messages;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Looper;
import android.provider.Telephony;
import com.getcapacitor.JSObject;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/**
 * One owner-selected conversation deletion: the thread's settled SMS and MMS rows dated at or
 * before {@code through}, the date of the newest row the owner saw. A row that arrived later, and
 * every row of a send (draft, outbox, queued or failed), stays. {@link #inspect} counts the rows
 * before the deletion is staged in the host's Undo window; {@link #dispatch} is that window's one
 * provider call at expiry. It never sends, cancels a send or retries an effect.
 */
public final class ThreadDeletion {
 private ThreadDeletion() {}
 private static final long MAX_DATE = 9007199254740991L;
 private static final String SETTLED = " IN (" + SmsRecords.INBOX + "," + SmsRecords.SENT + ")";
 private static final String SMS_ROWS = "thread_id = ? AND date <= ? AND " + Telephony.Sms.TYPE;
 private static final String MMS_ROWS = "thread_id = ? AND date <= ? AND " + Telephony.Mms.MESSAGE_BOX;

 /** The conversation and the boundary the owner reviewed, in the namespace of listThreads. */
 public static final class Reference {
  final String threadId; final long thread, through;
  Reference(String threadId, long thread, long through) { this.threadId = threadId; this.thread = thread; this.through = through; }
  public JSObject json() { JSObject value = new JSObject(); value.put("threadId", threadId); value.put("through", through); return value; }
  String[] smsArgs() { return new String[] { Long.toString(thread), Long.toString(through) }; }
  String[] mmsArgs() { return new String[] { Long.toString(thread), Long.toString(SmsRecords.mmsSecondsThrough(through)) }; }
 }

 /** Exactly {@code {threadId, through}} with a listed thread ID and a whole positive date. */
 public static Reference reference(JSONObject data) {
  if (data == null || data.length() != 2 || !(data.opt("threadId") instanceof String) || !(data.opt("through") instanceof Number)) throw new IllegalArgumentException("Invalid selected conversation");
  String threadId = (String) data.opt("threadId"); long thread = SmsRecords.threadRow(threadId);
  double through = ((Number) data.opt("through")).doubleValue();
  if (thread < 1 || !Double.isFinite(through) || through != Math.rint(through) || through < 1 || through > MAX_DATE) throw new IllegalArgumentException("Invalid selected conversation");
  return new Reference(threadId, thread, (long) through);
 }

 private static JSObject result(Reference target, String status) {
  JSObject value = new JSObject(); value.put("status", status); value.put("thread", target.json()); return value;
 }

 /** Rows of the conversation at or before the boundary: settled ones and ones that belong to a send. */
 static final class Counts {
  final int settled, inSend;
  Counts(int settled, int inSend) { this.settled = settled; this.inSend = inSend; }
 }

 private static int count(ContentResolver resolver, Uri collection, String selection, String[] args, CancellationSignal cancel) {
  if (cancel != null) cancel.throwIfCanceled();
  try (Cursor rows = resolver.query(collection, new String[] { "_id" }, selection, args, null, cancel)) {
   if (rows == null) throw new IllegalStateException("Messages provider unavailable");
   return rows.getCount();
  }
 }

 static Counts counts(ContentResolver resolver, Reference target, CancellationSignal cancel) {
  int settled = count(resolver, Telephony.Sms.CONTENT_URI, SMS_ROWS + SETTLED, target.smsArgs(), cancel)
   + count(resolver, Telephony.Mms.CONTENT_URI, MMS_ROWS + SETTLED, target.mmsArgs(), cancel);
  int inSend = count(resolver, Telephony.Sms.CONTENT_URI, SMS_ROWS + " NOT" + SETTLED, target.smsArgs(), cancel)
   + count(resolver, Telephony.Mms.CONTENT_URI, MMS_ROWS + " NOT" + SETTLED, target.mmsArgs(), cancel);
  return new Counts(settled, inSend);
 }

 private static boolean allowed(BooleanSupplier guard, CancellationSignal cancel) {
  try { return (cancel == null || !cancel.isCanceled()) && guard.getAsBoolean(); }
  catch (RuntimeException unreadable) { return false; }
 }

 private static String staged(Counts seen) { return seen.settled > 0 ? null : seen.inSend > 0 ? "not-settled" : "not-found"; }

 /**
  * Counts the conversation's rows at or before the boundary under the same authority as a
  * deletion: null when a settled row is among them, otherwise {@code not-settled} when every one
  * belongs to a send, or {@code not-found}. Nothing is written.
  */
 public static String inspect(Context context, Reference target, CancellationSignal cancel, BooleanSupplier guard) throws MessageDeletion.Refused {
  if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Conversation inspection must run off the main thread");
  if (!allowed(guard, cancel)) throw new MessageDeletion.Refused("Messages access changed before deletion");
  final Counts seen;
  try { seen = counts(context.getContentResolver(), target, cancel); }
  catch (RuntimeException unreadable) { throw new MessageDeletion.Refused("The selected conversation could not be read"); }
  if (!allowed(guard, cancel)) throw new MessageDeletion.Refused("Messages access changed before deletion");
  return staged(seen);
 }

 /**
  * Deletes the conversation's settled rows at or before the boundary, SMS then MMS, with the
  * settled boxes in the selection so that a row in a send is never removed. Deleted only when
  * Android removed rows and a second count finds no settled row left; a removal of nothing with
  * none left is not-found; a lost reply or any other count is unknown, never repeated.
  */
 public static JSObject delete(Context context, Reference target, BooleanSupplier guard) throws MessageDeletion.Refused {
  if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Conversation deletion must run off the main thread");
  if (!allowed(guard, null)) throw new MessageDeletion.Refused("Messages access changed before deletion");
  ContentResolver resolver = context.getContentResolver(); final Counts before;
  try { before = counts(resolver, target, null); }
  catch (RuntimeException unreadable) { throw new MessageDeletion.Refused("The selected conversation could not be read"); }
  String refusal = staged(before);
  if (refusal != null) return result(target, refusal);
  if (!allowed(guard, null)) throw new MessageDeletion.Refused("Messages access changed before deletion");
  int removed;
  try {
   removed = resolver.delete(Telephony.Sms.CONTENT_URI, SMS_ROWS + SETTLED, target.smsArgs());
   removed += resolver.delete(Telephony.Mms.CONTENT_URI, MMS_ROWS + SETTLED, target.mmsArgs());
  } catch (RuntimeException lostReply) { return result(target, "unknown"); }
  final Counts after;
  try { after = counts(resolver, target, null); }
  catch (RuntimeException unreadable) { return result(target, "unknown"); }
  if (after.settled == 0 && removed >= 1 && removed <= before.settled) return result(target, "deleted");
  if (after.settled == 0 && removed == 0) return result(target, "not-found");
  return result(target, "unknown");
 }

 /**
  * The Undo window's provider call for a staged {@code {threadId, through}}: one {@link #delete}
  * under {@code guard}, answered as {@code deleted}, {@code conflict} (nothing left to delete, or
  * not readable), {@code unknown} or, when the guard no longer holds, {@code permission-required}.
  */
 public static JSObject dispatch(Context context, JSONObject staged, BooleanSupplier guard) {
  JSObject value = new JSObject();
  if (!allowed(guard, null)) { value.put("status", "permission-required"); return value; }
  String status;
  try { status = delete(context, reference(staged), guard).getString("status"); }
  catch (MessageDeletion.Refused | IllegalArgumentException nothingWritten) { status = "conflict"; }
  catch (RuntimeException lost) { status = "unknown"; }
  value.put("status", "deleted".equals(status) || "unknown".equals(status) ? status : "conflict");
  return value;
 }
}

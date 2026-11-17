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

/** One owner-selected local message deletion. It never sends, cancels a send or retries an effect. */
public final class MessageDeletion {
 private MessageDeletion() {}
 private static final long MAX_DATE = 9007199254740991L;
 /** A refusal before a delete was dispatched; no provider write occurred. */
 public static final class Refused extends Exception {
  private static final long serialVersionUID = 1L;
  public final String code;
  Refused(String message) { super(message, null, false, false); code = "unavailable"; }
 }
 /** Content-free immutable identity, in the same units and namespace as listMessages. */
 public static final class Reference {
  final String id, kind, threadId; final long row, thread, date;
  Reference(String id, String kind, String threadId, long row, long thread, long date) {
   this.id=id; this.kind=kind; this.threadId=threadId; this.row=row; this.thread=thread; this.date=date;
  }
  public JSObject json() {
   JSObject value=new JSObject(); value.put("id",id); value.put("kind",kind); value.put("threadId",threadId); value.put("date",date); return value;
  }
  Uri collection() { return kind.equals("sms") ? Telephony.Sms.CONTENT_URI : Telephony.Mms.CONTENT_URI; }
  /** SMS TYPE or MMS MESSAGE_BOX: the same 1..6 box values in each table. */
  String box() { return kind.equals("sms") ? Telephony.Sms.TYPE : Telephony.Mms.MESSAGE_BOX; }
 }
 /**
  * Only received and sent rows are settled. Draft, outbox, queued and failed rows belong to a send
  * that the composer or the radio may still own or retry; deleting one could remove an in-flight send.
  */
 static boolean settled(int box) { return box==SmsRecords.INBOX || box==SmsRecords.SENT; }
 private static final String SETTLED_BOXES = " IN ("+SmsRecords.INBOX+","+SmsRecords.SENT+")";
 public static Reference reference(JSONObject data) {
  if (data == null || data.length()!=4 || !(data.opt("id") instanceof String) || !(data.opt("kind") instanceof String)
      || !(data.opt("threadId") instanceof String) || !(data.opt("date") instanceof Number)) throw new IllegalArgumentException("Invalid selected message");
  String id=(String)data.opt("id"), kind=(String)data.opt("kind"), threadId=(String)data.opt("threadId");
  double date=((Number)data.opt("date")).doubleValue(); long thread=SmsRecords.threadRow(threadId);
  if ((!kind.equals("sms")&&!kind.equals("mms")) || !id.matches(kind+ ":[1-9][0-9]{0,17}") || thread<1
      || !Double.isFinite(date) || date!=Math.rint(date) || date<0 || date>MAX_DATE) throw new IllegalArgumentException("Invalid selected message");
  return new Reference(id,kind,threadId,Long.parseLong(id.substring(4)),thread,(long)date);
 }
 private static JSObject result(Reference target,String status) {
  JSObject value=new JSObject(); value.put("status",status); value.put("message",target.json()); return value;
 }
 private static final class Identity {
  final long thread, rawDate; final int box;
  Identity(long thread,long rawDate,int box) { this.thread=thread; this.rawDate=rawDate; this.box=box; }
  boolean matches(Reference target) { return thread==target.thread && (target.kind.equals("mms")?SmsRecords.mmsMillis(rawDate):rawDate)==target.date; }
 }
 private static Identity lookup(ContentResolver resolver,Reference target,CancellationSignal cancel) {
  if (cancel!=null) cancel.throwIfCanceled();
  try (Cursor row=resolver.query(target.collection(),new String[]{"_id","thread_id","date",target.box()},"_id = ?",new String[]{Long.toString(target.row)},null,cancel)) {
   if (row==null) throw new IllegalStateException("Messages provider unavailable");
   if (!row.moveToFirst()) return null;
   if (row.isNull(0)||row.isNull(1)||row.isNull(2)||row.isNull(3)||row.getLong(0)!=target.row) throw new IllegalStateException("Unreadable message identity");
   Identity value=new Identity(row.getLong(1),row.getLong(2),row.getInt(3));
   if (value.thread<1||value.rawDate<0||row.moveToNext()) throw new IllegalStateException("Unreadable message identity");
   if (cancel!=null) cancel.throwIfCanceled();
   return value;
  }
 }
 private static boolean allowed(BooleanSupplier guard,CancellationSignal cancel) {
  try { return (cancel==null||!cancel.isCanceled()) && guard.getAsBoolean(); }
  catch (RuntimeException unreadable) { return false; }
 }
 /**
  * Read only identity, recheck authority, then bind the collection delete to the observed raw date
  * and to a settled box, so a row that is or becomes part of a send is answered not-settled.
  * Android's single-message URI ignores selection; it must not be used for this conditional write.
  * Once dispatched, a lost reply is unknown and never retried. Known content-free outcomes survive
  * a later access change. The guard must include current image/profile, foreground, SMS read and role.
  */
 public static JSObject delete(Context context,Reference target,CancellationSignal cancel,BooleanSupplier guard) throws Refused {
  if (Looper.myLooper()==Looper.getMainLooper()) throw new IllegalStateException("Message deletion must run off the main thread");
  if (!allowed(guard,cancel)) throw new Refused("Messages access changed before deletion");
  ContentResolver resolver=context.getContentResolver(); final Identity before;
  try { before=lookup(resolver,target,cancel); }
  catch (RuntimeException unreadable) { throw new Refused("The selected message could not be read"); }
  if (!allowed(guard,cancel)) throw new Refused("Messages access changed before deletion");
  if (before==null) return result(target,"not-found");
  if (!before.matches(target)) return result(target,"stale");
  if (!settled(before.box)) return result(target,"not-settled");
  final int count;
  try {
   // Collection selection is the atomic identity check; row-URI deletion is not conditional.
   count=resolver.delete(target.collection(),"_id = ? AND thread_id = ? AND date = ? AND "+target.box()+SETTLED_BOXES,
     new String[]{Long.toString(target.row),Long.toString(target.thread),Long.toString(before.rawDate)});
  } catch (RuntimeException lostReply) { return result(target,"unknown"); }
  if (count==1) return result(target,"deleted");
  if (count!=0 || !allowed(guard,cancel)) return result(target,"unknown");
  try {
   Identity after=lookup(resolver,target,cancel);
   if (after==null) return result(target,"not-found");
   if (!after.matches(target)||after.rawDate!=before.rawDate) return result(target,"stale");
   return result(target,settled(after.box)?"unknown":"not-settled");
  } catch (RuntimeException unreadable) { return result(target,"unknown"); }
 }
}

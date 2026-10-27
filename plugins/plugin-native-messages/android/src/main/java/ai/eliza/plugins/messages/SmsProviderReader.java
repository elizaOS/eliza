package ai.eliza.plugins.messages;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.Telephony;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Bounded reads of the Android SMS, MMS and conversation providers (READ_SMS). Pages hold at most
 * {@link SmsRecords#MAX_THREADS} threads or {@link SmsRecords#MAX_MESSAGES} messages, take the caller's
 * CancellationSignal, and refuse a row they cannot report completely (a body above
 * {@link SmsRecords#MAX_BODY} characters, more than {@link SmsRecords#MAX_ADDRESSES} addresses, MMS text
 * stored as an attachment) instead of truncating it. Drafts and attachment bytes are never read.
 */
public final class SmsProviderReader {
 private SmsProviderReader() {}
 private static final Uri CONVERSATIONS = Uri.parse("content://mms-sms/conversations?simple=true");
 private static final Uri CANONICAL_ADDRESSES = Uri.parse("content://mms-sms/canonical-addresses");
 private static final int MMS_FROM = 137;

 private static Cursor query(ContentResolver resolver, Uri uri, String[] projection, String selection, String[] args, String order, CancellationSignal cancel) {
  return resolver.query(uri, projection, selection, args, order, cancel);
 }
 static long longAt(Cursor c, String column) { int i = c.getColumnIndex(column); return i < 0 || c.isNull(i) ? 0 : c.getLong(i); }
 static int intAt(Cursor c, String column, int otherwise) { int i = c.getColumnIndex(column); return i < 0 || c.isNull(i) ? otherwise : c.getInt(i); }
 static String textAt(Cursor c, String column) { int i = c.getColumnIndex(column); return i < 0 || c.isNull(i) ? null : c.getString(i); }

 /** Conversation threads, newest first, before an optional date (exclusive). */
 private static String complete(String value, int limit) { if (value != null && value.length() > limit) throw new IllegalStateException("Message exceeds complete read bound; use the system messaging app"); return value == null ? "" : value; }
 public static JSObject threads(Context context, int limit, long before, SmsPageCursor cursor, CancellationSignal cancel) {
  ContentResolver resolver = context.getContentResolver();
  JSArray rows = new JSArray();
  List<String[]> recipientIds = new ArrayList<>();
  List<JSObject> pending = new ArrayList<>();
  Set<String> ids = new HashSet<>();
  try (Cursor c = query(resolver, CONVERSATIONS, new String[] { "_id", "date", "message_count", "recipient_ids", "snippet", "read" },
    cursor != null ? cursor.predicate("thread", "date", "_id") : before > 0 ? "date < ?" : null, cursor == null && before > 0 ? new String[] { Long.toString(before) } : null, "date DESC, _id DESC", cancel)) {
   if (c == null) throw new IllegalStateException("Messages provider unavailable");
   while (c.moveToNext() && pending.size() < limit + 1) {
    cancel.throwIfCanceled();
    long id = longAt(c, "_id");
    if (id <= 0) continue;
    String raw = textAt(c, "recipient_ids");
    String[] members = raw == null || raw.trim().isEmpty() ? new String[0] : raw.trim().split("\\s+");
    if (members.length > SmsRecords.MAX_ADDRESSES) throw new IllegalStateException("Thread has too many addresses to read completely");
    for (String member : members) if (member.matches("[0-9]{1,18}")) ids.add(member);
    JSObject row = new JSObject();
    row.put("id", SmsRecords.threadId(id));
    row.put("date", longAt(c, "date"));
    row.put("messageCount", Math.max(0, intAt(c, "message_count", 0)));
    row.put("snippet", SmsRecords.clip(textAt(c, "snippet"), 160));
    row.put("unread", intAt(c, "read", 1) == 0);
    pending.add(row); recipientIds.add(members);
   }
  }
  java.util.Map<String, String> addresses = canonicalAddresses(resolver, ids, cancel);
  for (int i = 0; i < pending.size(); i++) {
   JSArray people = new JSArray();
   for (String member : recipientIds.get(i)) { String address = addresses.get(member); if (address == null) throw new IllegalStateException("Thread address unavailable"); people.put(complete(address, 64)); }
   pending.get(i).put("addresses", people);
   rows.put(pending.get(i));
  }
  JSObject value = new JSObject();
  boolean more = rows.length() > limit;
  if (more) rows.remove(rows.length()-1);
  value.put("threads", rows);
  JSObject last = rows.length() == 0 ? null : (JSObject) rows.opt(rows.length()-1);
  value.put("next", more && last != null ? new SmsPageCursor(last.optLong("date"), "thread", Long.parseLong(last.optString("id").substring(7))).toString() : JSONObject.NULL);
  return value;
 }
 private static java.util.Map<String, String> canonicalAddresses(ContentResolver resolver, Set<String> ids, CancellationSignal cancel) {
  java.util.Map<String, String> found = new java.util.HashMap<>();
  // Up to 50 threads x 20 members: chunked below SQLite's 999 bound-argument limit.
  List<String> all = new ArrayList<>(ids);
  for (int start = 0; start < all.size(); start += 500) {
   List<String> chunk = all.subList(start, Math.min(all.size(), start + 500));
   StringBuilder in = new StringBuilder();
   for (int i = 0; i < chunk.size(); i++) in.append(i == 0 ? "?" : ",?");
   try (Cursor c = query(resolver, CANONICAL_ADDRESSES, new String[] { "_id", "address" }, "_id IN (" + in + ")", chunk.toArray(new String[0]), null, cancel)) {
    if (c == null) throw new IllegalStateException("Address provider unavailable");
    while (c.moveToNext() && found.size() < ids.size()) found.put(Long.toString(longAt(c, "_id")), textAt(c, "address"));
   }
  }
  return found;
 }

 /** Messages of one thread, newest first, SMS and MMS merged, before an optional date (exclusive, milliseconds). */
 public static JSObject messages(Context context, long thread, int limit, long before, SmsPageCursor cursor, CancellationSignal cancel) {
  ContentResolver resolver = context.getContentResolver();
  List<JSObject> all = new ArrayList<>();
  String[] sms = { Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.STATUS, Telephony.Sms.READ, Telephony.Sms.SUBSCRIPTION_ID };
  String smsWhere = Telephony.Sms.THREAD_ID + " = ? AND " + Telephony.Sms.TYPE + " IN (1,2,4,5,6)" + (before > 0 ? " AND " + Telephony.Sms.DATE + " < ?" : "");
  if (cursor != null) smsWhere += " AND " + cursor.predicate("sms", Telephony.Sms.DATE, Telephony.Sms._ID);
  String[] smsArgs = before > 0 ? new String[] { Long.toString(thread), Long.toString(before) } : new String[] { Long.toString(thread) };
  try (Cursor c = query(resolver, Telephony.Sms.CONTENT_URI, sms, smsWhere, smsArgs, Telephony.Sms.DATE + " DESC, _id DESC", cancel)) {
   int taken = 0;
   if (c == null) throw new IllegalStateException("SMS provider unavailable");
   while (c.moveToNext() && taken < limit + 1) {
    cancel.throwIfCanceled();
    int type = intAt(c, Telephony.Sms.TYPE, 0), status = intAt(c, Telephony.Sms.STATUS, SmsSendJournal.STATUS_NONE);
    boolean read = intAt(c, Telephony.Sms.READ, 0) != 0;
    String direction = SmsRecords.direction(type), state = SmsRecords.smsStatus(type, status, read);
    if (direction == null || state == null) continue;
    JSObject row = message(false, longAt(c, Telephony.Sms._ID), thread, direction, state, longAt(c, Telephony.Sms.DATE), read, intAt(c, Telephony.Sms.SUBSCRIPTION_ID, -1));
    JSArray addresses = new JSArray(); String address = textAt(c, Telephony.Sms.ADDRESS); if (address != null) addresses.put(complete(address, 64));
    row.put("addresses", addresses);
    row.put("body", complete(textAt(c, Telephony.Sms.BODY), SmsRecords.MAX_BODY));
    String report = SmsRecords.smsDeliveryReport(type, status);
    row.put("deliveryReport", report == null ? JSONObject.NULL : report);
    row.put("attachments", 0);
    all.add(row); taken++;
   }
  }
  String[] mms = { Telephony.Mms._ID, Telephony.Mms.DATE, Telephony.Mms.MESSAGE_BOX, Telephony.Mms.READ, Telephony.Mms.SUBSCRIPTION_ID };
  String mmsWhere = Telephony.Mms.THREAD_ID + " = ? AND " + Telephony.Mms.MESSAGE_BOX + " IN (1,2,4,5,6)" + (before > 0 ? " AND " + Telephony.Mms.DATE + " < ?" : "");
  if (cursor != null) mmsWhere += " AND " + cursor.predicate("mms", Telephony.Mms.DATE, Telephony.Mms._ID);
  String[] mmsArgs = before > 0 ? new String[] { Long.toString(thread), Long.toString((before + 999) / 1000) } : new String[] { Long.toString(thread) };
  List<JSObject> mmsRows = new ArrayList<>();
  try (Cursor c = query(resolver, Telephony.Mms.CONTENT_URI, mms, mmsWhere, mmsArgs, Telephony.Mms.DATE + " DESC, _id DESC", cancel)) {
   if (c == null) throw new IllegalStateException("MMS provider unavailable");
   while (c.moveToNext() && mmsRows.size() < limit + 1) {
    cancel.throwIfCanceled();
    int box = intAt(c, Telephony.Mms.MESSAGE_BOX, 0);
    boolean read = intAt(c, Telephony.Mms.READ, 0) != 0;
    String direction = SmsRecords.direction(box), state = SmsRecords.mmsStatus(box, read);
    if (direction == null || state == null) continue;
    long date = SmsRecords.mmsMillis(longAt(c, Telephony.Mms.DATE));
    if (before > 0 && date >= before) continue;
    mmsRows.add(message(true, longAt(c, Telephony.Mms._ID), thread, direction, state, date, read, intAt(c, Telephony.Mms.SUBSCRIPTION_ID, -1)));
   }
  }
  for (JSObject row : mmsRows) { mmsContent(resolver, row, cancel); all.add(row); }
  all.sort((a, b) -> SmsPageCursor.compare(a.optLong("date"), a.optString("kind"), Long.parseLong(a.optString("id").substring(4)), b.optLong("date"), b.optString("kind"), Long.parseLong(b.optString("id").substring(4))));
  JSArray rows = new JSArray();
  for (int i = 0; i < all.size() && i < limit; i++) rows.put(all.get(i));
  JSObject value = new JSObject();
  value.put("messages", rows);
  JSObject last = rows.length() == 0 ? null : (JSObject) rows.opt(rows.length()-1);
  value.put("next", all.size() > limit && last != null ? new SmsPageCursor(last.optLong("date"), last.optString("kind"), Long.parseLong(last.optString("id").substring(4))).toString() : JSONObject.NULL);
  return value;
 }
 private static JSObject message(boolean mms, long id, long thread, String direction, String status, long date, boolean read, int subscription) {
  JSObject row = new JSObject();
  row.put("id", SmsRecords.messageId(mms, id));
  row.put("kind", mms ? "mms" : "sms");
  row.put("threadId", SmsRecords.threadId(thread));
  row.put("direction", direction);
  row.put("status", status);
  row.put("date", date);
  row.put("read", read);
  row.put("subscriptionId", subscription >= 0 ? (Object) subscription : JSONObject.NULL);
  return row;
 }
 /** Text parts (bounded) and the attachment count of one MMS; attachment bytes are never read. */
 private static void mmsContent(ContentResolver resolver, JSObject row, CancellationSignal cancel) {
  String id = row.optString("id").substring(4);
  StringBuilder body = new StringBuilder(); int attachments = 0;
  try (Cursor c = query(resolver, Uri.parse("content://mms/part"), new String[] { "_id", "ct", "text" }, "mid = ?", new String[] { id }, null, cancel)) {
   if (c == null) throw new IllegalStateException("MMS parts unavailable");
   int seen = 0;
   while (c.moveToNext()) {
    if (++seen > 32) throw new IllegalStateException("MMS has too many parts to read completely");
    String type = textAt(c, "ct");
    if ("text/plain".equals(type)) { String text = textAt(c, "text"); if (text == null) throw new IllegalStateException("MMS text is stored as an attachment; use the system messaging app"); complete(text, SmsRecords.MAX_BODY); body.append(body.length() == 0 ? "" : "\n").append(text); }
    else if (type != null && !"application/smil".equals(type)) attachments++;
   }
  }
  JSArray addresses = new JSArray(); String direction = row.optString("direction");
  try (Cursor c = query(resolver, Uri.parse("content://mms/" + id + "/addr"), new String[] { "address", "type" }, null, null, null, cancel)) {
   if (c == null) throw new IllegalStateException("MMS addresses unavailable");
   while (c.moveToNext()) {
    if (addresses.length() >= SmsRecords.MAX_ADDRESSES) throw new IllegalStateException("MMS has too many addresses to read completely");
    int type = intAt(c, "type", 0); String address = textAt(c, "address");
    // Incoming: the sender. Outgoing: the recipients (to, cc, bcc), never Alpha's own number.
    if (address == null || "insert-address-token".equals(address)) continue;
    if ("incoming".equals(direction) ? type == MMS_FROM : type != MMS_FROM) addresses.put(complete(address, 64));
   }
  }
  row.put("addresses", addresses);
  row.put("body", complete(body.toString(), SmsRecords.MAX_BODY));
  row.put("deliveryReport", JSONObject.NULL);
  row.put("attachments", attachments);
 }
}

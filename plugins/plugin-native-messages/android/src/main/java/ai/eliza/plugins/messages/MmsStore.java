package ai.eliza.plugins.messages;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.PhoneNumberUtils;
import android.telephony.TelephonyManager;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Provider writes and notices owed by the default SMS app. Android stores incoming messages, and the
 * texts the role holder sends, only through that app, so a message the holder fails to persist is
 * lost; every write here either completes or throws, and nothing is reported as stored before the
 * provider returns.
 */
public final class MmsStore {
 private MmsStore() {}
 static final int ADDRESS_FROM = 137, ADDRESS_TO = 151, ADDRESS_CC = 130;
 private static final String FILES = "eliza-mms";

 public static boolean isDefaultSmsApp(Context context) {
  try { return context.getPackageName().equals(Telephony.Sms.getDefaultSmsPackage(context)); }
  catch (RuntimeException unreadable) { return false; }
 }

 /** Inserts one incoming SMS (parts already joined) into the inbox and returns its row. */
 public static Uri persistIncomingSms(Context context, String sender, String body, long timestamp, int subscriptionId) {
  if (sender == null || sender.isEmpty() || body == null) throw new IllegalArgumentException("Incoming SMS without sender or body");
  ContentValues values = new ContentValues();
  values.put(Telephony.Sms.ADDRESS, sender);
  values.put(Telephony.Sms.BODY, body);
  long at = timestamp > 0 ? timestamp : System.currentTimeMillis();
  values.put(Telephony.Sms.DATE, System.currentTimeMillis());
  values.put(Telephony.Sms.DATE_SENT, at);
  values.put(Telephony.Sms.READ, 0);
  values.put(Telephony.Sms.SEEN, 0);
  values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX);
  if (subscriptionId >= 0) values.put(Telephony.Sms.SUBSCRIPTION_ID, subscriptionId);
  Uri row = context.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, values);
  if (row == null) throw new IllegalStateException("SMS provider refused the incoming message");
  return row;
 }

 /**
  * Inserts one reviewed outgoing SMS into the outbox and returns its row. Android writes the sent
  * messages of every app except the default SMS app, which must write its own, so without this row
  * the text would be missing from every conversation view. Sent callbacks later move it to sent or
  * failed ({@link #settleOutgoingSms}). Its delivery status stays "none": an immutable delivery
  * callback carries no status report, so delivery is never claimed for these rows.
  */
 public static long persistOutgoingSms(Context context, String recipient, String body, int subscriptionId, long timestamp) {
  if (recipient == null || recipient.isEmpty() || body == null) throw new IllegalArgumentException("Outgoing SMS without recipient or body");
  ContentValues values = new ContentValues();
  values.put(Telephony.Sms.ADDRESS, recipient);
  values.put(Telephony.Sms.BODY, body);
  values.put(Telephony.Sms.DATE, timestamp > 0 ? timestamp : System.currentTimeMillis());
  values.put(Telephony.Sms.READ, 1);
  values.put(Telephony.Sms.SEEN, 1);
  values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_OUTBOX);
  if (subscriptionId >= 0) values.put(Telephony.Sms.SUBSCRIPTION_ID, subscriptionId);
  Uri row = context.getContentResolver().insert(Telephony.Sms.Outbox.CONTENT_URI, values);
  long id = row == null ? -1 : ContentUris.parseId(row);
  if (id <= 0) throw new IllegalStateException("SMS provider refused the outgoing message");
  return id;
 }

 /**
  * Moves an outgoing row out of the outbox to {@link SmsSendJournal#TYPE_SENT} or
  * {@link SmsSendJournal#TYPE_FAILED}. Only an outbox row this app created changes; a row Android or
  * another app wrote is never touched.
  */
 public static boolean settleOutgoingSms(Context context, long row, int type) {
  if (row <= 0 || (type != SmsSendJournal.TYPE_SENT && type != SmsSendJournal.TYPE_FAILED)) throw new IllegalArgumentException("Invalid outgoing SMS outcome");
  ContentValues values = new ContentValues();
  values.put(Telephony.Sms.TYPE, type);
  return context.getContentResolver().update(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, row), values,
    Telephony.Sms.TYPE + " = ? AND " + Telephony.Sms.CREATOR + " = ?",
    new String[] { Integer.toString(SmsSendJournal.TYPE_OUTBOX), context.getPackageName() }) == 1;
 }

 /**
  * Marks one conversation's received SMS and MMS read and seen, up to the newest message the owner
  * had on screen ({@code throughMillis}), and removes the conversation's notice. Read state is the
  * default SMS app's to keep: Android ignores this write from any other app, so the count is 0 there.
  * Messages that arrived after the shown page keep their unread state.
  */
 public static int markThreadRead(Context context, long thread, long throughMillis) {
  if (thread <= 0 || throughMillis <= 0) throw new IllegalArgumentException("Invalid conversation read marker");
  ContentResolver resolver = context.getContentResolver();
  ContentValues sms = new ContentValues();
  sms.put(Telephony.Sms.READ, 1); sms.put(Telephony.Sms.SEEN, 1);
  int updated = resolver.update(Telephony.Sms.CONTENT_URI, sms,
    Telephony.Sms.THREAD_ID + " = ? AND " + Telephony.Sms.TYPE + " = ? AND " + Telephony.Sms.DATE + " <= ? AND (" + Telephony.Sms.READ + " = 0 OR " + Telephony.Sms.SEEN + " = 0)",
    new String[] { Long.toString(thread), Integer.toString(SmsRecords.INBOX), Long.toString(throughMillis) });
  ContentValues mms = new ContentValues();
  mms.put(Telephony.Mms.READ, 1); mms.put(Telephony.Mms.SEEN, 1);
  updated += resolver.update(Telephony.Mms.CONTENT_URI, mms,
    Telephony.Mms.THREAD_ID + " = ? AND " + Telephony.Mms.MESSAGE_BOX + " = ? AND " + Telephony.Mms.DATE + " <= ? AND (" + Telephony.Mms.READ + " = 0 OR " + Telephony.Mms.SEEN + " = 0)",
    new String[] { Long.toString(thread), Integer.toString(SmsRecords.INBOX), Long.toString(SmsRecords.mmsSecondsThrough(throughMillis)) });
  cancelThreadNotice(context, thread);
  return updated;
 }

 /** True when a message with this MMS transaction ID is already stored (a repeated notification). */
 public static boolean hasTransaction(Context context, String transactionId) {
  try (Cursor c = context.getContentResolver().query(Telephony.Mms.CONTENT_URI, new String[] { Telephony.Mms._ID }, Telephony.Mms.TRANSACTION_ID + " = ?", new String[] { transactionId }, null)) {
   return c != null && c.moveToFirst();
  }
 }

 /** This subscription's own number when Android reports it; used only to leave it out of thread members. */
 private static String ownNumber(Context context, int subscriptionId) {
  try {
   TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
   if (telephony == null) return null;
   if (subscriptionId >= 0) telephony = telephony.createForSubscriptionId(subscriptionId);
   return telephony.getLine1Number();
  } catch (RuntimeException unavailable) { return null; }
 }

 /**
  * Stores a retrieved MMS (M-Retrieve.conf) in the inbox of its conversation: the message row, its
  * sender and recipients, and every part (text in the provider's text column, other parts as bytes).
  */
 public static Uri persistIncomingMms(Context context, MmsPdu.Message message, int subscriptionId, String contentLocation) throws IOException {
  if (message.type != MmsPdu.RETRIEVE_CONF) throw new IllegalArgumentException("Not a retrieved MMS");
  ContentResolver resolver = context.getContentResolver();
  String self = ownNumber(context, subscriptionId);
  Set<String> members = new LinkedHashSet<>();
  if (message.from != null) members.add(message.from);
  for (String address : message.to) if (self == null || !PhoneNumberUtils.compare(address, self)) members.add(address);
  for (String address : message.cc) if (self == null || !PhoneNumberUtils.compare(address, self)) members.add(address);
  if (members.isEmpty()) throw new IllegalArgumentException("MMS without addresses");
  long thread = Telephony.Threads.getOrCreateThreadId(context, members);
  long now = System.currentTimeMillis() / 1000;
  ContentValues values = new ContentValues();
  values.put(Telephony.Mms.THREAD_ID, thread);
  values.put(Telephony.Mms.DATE, now);
  values.put(Telephony.Mms.DATE_SENT, message.date > 0 ? message.date : now);
  values.put(Telephony.Mms.MESSAGE_BOX, Telephony.Mms.MESSAGE_BOX_INBOX);
  values.put(Telephony.Mms.READ, 0);
  values.put(Telephony.Mms.SEEN, 0);
  values.put(Telephony.Mms.MESSAGE_TYPE, MmsPdu.RETRIEVE_CONF);
  values.put(Telephony.Mms.MMS_VERSION, message.version > 0 ? message.version : MmsPdu.VERSION_1_2);
  if (message.transactionId != null) values.put(Telephony.Mms.TRANSACTION_ID, message.transactionId);
  if (message.messageId != null) values.put(Telephony.Mms.MESSAGE_ID, message.messageId);
  if (message.subject != null) { values.put(Telephony.Mms.SUBJECT, message.subject); values.put(Telephony.Mms.SUBJECT_CHARSET, MmsPdu.MIB_UTF8); }
  if (message.contentType != null) values.put(Telephony.Mms.CONTENT_TYPE, message.contentType);
  if (contentLocation != null) values.put(Telephony.Mms.CONTENT_LOCATION, contentLocation);
  if (message.size > 0) values.put(Telephony.Mms.MESSAGE_SIZE, message.size);
  values.put(Telephony.Mms.MESSAGE_CLASS, "personal");
  values.put(Telephony.Mms.TEXT_ONLY, MmsPdu.attachments(message).isEmpty() ? 1 : 0);
  if (subscriptionId >= 0) values.put(Telephony.Mms.SUBSCRIPTION_ID, subscriptionId);
  Uri row = resolver.insert(Telephony.Mms.Inbox.CONTENT_URI, values);
  if (row == null) throw new IllegalStateException("MMS provider refused the message");
  String id = row.getLastPathSegment();
  try {
   if (message.from != null) address(resolver, id, message.from, ADDRESS_FROM);
   for (String address : message.to) address(resolver, id, address, ADDRESS_TO);
   for (String address : message.cc) address(resolver, id, address, ADDRESS_CC);
   for (MmsPdu.Part part : message.parts) part(resolver, id, part);
  } catch (IOException | RuntimeException failed) {
   // A half-written message would read as complete; remove it so the carrier's retry can store it whole.
   resolver.delete(row, null, null);
   throw failed;
  }
  return row;
 }
 private static void address(ContentResolver resolver, String id, String address, int type) {
  ContentValues values = new ContentValues();
  values.put(Telephony.Mms.Addr.ADDRESS, address);
  values.put(Telephony.Mms.Addr.TYPE, type);
  values.put(Telephony.Mms.Addr.CHARSET, MmsPdu.MIB_UTF8);
  values.put(Telephony.Mms.Addr.MSG_ID, id);
  if (resolver.insert(Uri.parse("content://mms/" + id + "/addr"), values) == null) throw new IllegalStateException("MMS address refused");
 }
 private static void part(ContentResolver resolver, String id, MmsPdu.Part part) throws IOException {
  ContentValues values = new ContentValues();
  values.put(Telephony.Mms.Part.MSG_ID, id);
  values.put(Telephony.Mms.Part.CONTENT_TYPE, part.contentType);
  if (part.contentId != null) values.put(Telephony.Mms.Part.CONTENT_ID, part.contentId);
  if (part.location != null) values.put(Telephony.Mms.Part.CONTENT_LOCATION, part.location);
  if (part.name != null) { values.put(Telephony.Mms.Part.NAME, part.name); values.put(Telephony.Mms.Part.FILENAME, part.name); }
  boolean text = part.isText() || "application/smil".equalsIgnoreCase(part.contentType);
  if (text) { values.put(Telephony.Mms.Part.CHARSET, MmsPdu.MIB_UTF8); values.put(Telephony.Mms.Part.TEXT, part.text()); }
  Uri row = resolver.insert(Uri.parse("content://mms/" + id + "/part"), values);
  if (row == null) throw new IllegalStateException("MMS part refused");
  if (!text) try (OutputStream out = resolver.openOutputStream(row)) {
   if (out == null) throw new IOException("MMS part storage unavailable");
   out.write(part.data);
  }
 }

 // ---- Files the platform MMS service reads and writes through MmsFileProvider ----------------

 static File directory(Context context) {
  File dir = new File(context.getCacheDir(), FILES);
  if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("MMS file directory unavailable");
  return dir;
 }
 static String newFileName() { return UUID.randomUUID() + ".pdu"; }
 static boolean validFileName(String name) { return name != null && name.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdu"); }
 static File file(Context context, String name) {
  if (!validFileName(name)) throw new IllegalArgumentException("Invalid MMS file");
  return new File(directory(context), name);
 }
 static Uri fileUri(SmsRoleConfiguration config, String name) { return new Uri.Builder().scheme("content").authority(config.mmsFileAuthority).appendPath(name).build(); }
 static void delete(Context context, String name) { if (validFileName(name)) { File file = new File(directory(context), name); if (file.exists() && !file.delete()) android.util.Log.w("MmsStore", "MMS file not removed"); } }

 // ---- Notices ---------------------------------------------------------------------------------

 /** One notice per conversation, tagged with its thread ID: a newer message replaces it and reading the conversation removes it. */
 static final int NOTICE_ID = 1;
 static void cancelThreadNotice(Context context, long thread) {
  NotificationManager notifications = context.getSystemService(NotificationManager.class);
  if (notifications != null && thread > 0) notifications.cancel(SmsRecords.threadId(thread), NOTICE_ID);
 }
 /** The conversation a stored message belongs to, or 0 when the provider does not say. */
 private static long threadOf(Context context, Uri message) {
  try (Cursor c = context.getContentResolver().query(message, new String[] { Telephony.Sms.THREAD_ID }, null, null, null)) {
   return c != null && c.moveToFirst() && !c.isNull(0) ? c.getLong(0) : 0;
  } catch (RuntimeException unreadable) { return 0; }
 }
 /**
  * The sender's name in the owner's contacts when this app may read them, otherwise null and the
  * number is shown. One lookup in this profile only; nothing is read from a work profile.
  */
 static String contactName(Context context, String number) {
  if (number == null || number.trim().isEmpty() || context.checkSelfPermission(android.Manifest.permission.READ_CONTACTS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return null;
  Uri lookup = Uri.withAppendedPath(android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
  try (Cursor c = context.getContentResolver().query(lookup, new String[] { android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
   String name = c != null && c.moveToFirst() ? c.getString(0) : null;
   return name == null || name.trim().isEmpty() ? null : SmsRecords.clip(name, TelephonyPlugin.MAX_TEXT);
  } catch (RuntimeException unreadable) { return null; }
 }

 /**
  * A new-message notice for the message's conversation. The lock screen sees only "New message"; the
  * sender's contact name (or number) and the text show once unlocked.
  */
 static void notifyIncoming(Context context, SmsRoleConfiguration config, Uri message, String sender, String preview) {
  NotificationManager notifications = context.getSystemService(NotificationManager.class);
  if (notifications == null) return;
  NotificationChannel channel = new NotificationChannel(config.channelId, config.channelName, NotificationManager.IMPORTANCE_HIGH);
  notifications.createNotificationChannel(channel);
  PendingIntent open = PendingIntent.getActivity(context, 0, new Intent(context, config.openActivity).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  Notification publicVersion = new Notification.Builder(context, config.channelId).setSmallIcon(config.notificationIcon).setContentTitle("New message").build();
  String name = contactName(context, sender);
  long thread = threadOf(context, message);
  Notification notice = new Notification.Builder(context, config.channelId)
   .setSmallIcon(config.notificationIcon)
   .setContentTitle(name != null ? name : sender == null ? "Unknown sender" : sender)
   .setContentText(preview)
   .setStyle(new Notification.BigTextStyle().bigText(preview))
   .setCategory(Notification.CATEGORY_MESSAGE)
   .setVisibility(Notification.VISIBILITY_PRIVATE)
   .setPublicVersion(publicVersion)
   .setAutoCancel(true)
   .setContentIntent(open)
   .build();
  try { notifications.notify(thread > 0 ? SmsRecords.threadId(thread) : message.toString(), NOTICE_ID, notice); } catch (SecurityException notAllowed) { /* Notifications are off; the message is stored. */ }
 }
}

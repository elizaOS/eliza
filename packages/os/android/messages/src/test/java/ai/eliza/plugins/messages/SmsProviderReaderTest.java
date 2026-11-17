package ai.eliza.plugins.messages;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;

import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * SmsProviderReader against fake SMS, MMS and conversation providers: one row over a read bound
 * comes back content-free with its reason, and the rest of the page and its cursor go on.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class SmsProviderReaderTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

 /** Rows by table: "sms", "mms", "conversations", "canonical", "part:<mid>", "addr:<mid>". */
 static final Map<String, List<Map<String, Object>>> tables = new HashMap<>();
 static Map<String, Object> row(Object... pairs) {
  Map<String, Object> row = new HashMap<>();
  for (int i = 0; i < pairs.length; i += 2) row.put((String) pairs[i], pairs[i + 1]);
  return row;
 }
 static void add(String table, Map<String, Object> row) { tables.computeIfAbsent(table, k -> new ArrayList<>()).add(row); }

 public static final class Provider extends ContentProvider {
  @Override public boolean onCreate() { return true; }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
   List<String> path = uri.getPathSegments();
   String table; String match = null, key = null;
   if ("mms-sms".equals(uri.getAuthority())) {
    table = path.get(0).equals("conversations") ? "conversations" : "canonical";
    if (table.equals("canonical")) key = "_id";
   } else if ("sms".equals(uri.getAuthority())) { table = "sms"; key = "thread_id"; match = args[0]; }
   else if (path.isEmpty()) { table = "mms"; key = "thread_id"; match = args[0]; }
   else if (path.get(0).equals("part")) table = "part:" + args[0];
   else table = "addr:" + path.get(0);
   // A page cursor's "date < N" bound (the fixtures have no equal dates).
   java.util.regex.Matcher bound = java.util.regex.Pattern.compile("date < ([0-9]+)").matcher(selection == null ? "" : selection);
   long before = bound.find() ? Long.parseLong(bound.group(1)) : Long.MAX_VALUE;
   MatrixCursor cursor = new MatrixCursor(projection);
   for (Map<String, Object> r : tables.getOrDefault(table, new ArrayList<>())) {
    if (match != null && !match.equals(String.valueOf(r.get(key)))) continue;
    if (r.get("date") instanceof Long && (Long) r.get("date") >= before) continue;
    if (table.equals("canonical") && !Arrays.asList(args).contains(String.valueOf(r.get(key)))) continue;
    Object[] values = new Object[projection.length];
    for (int i = 0; i < projection.length; i++) values[i] = r.get(projection[i]);
    cursor.addRow(values);
   }
   return cursor;
  }
  @Override public String getType(Uri uri) { return null; }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
 }

 @Before public void providers() {
  tables.clear();
  // One registration per authority: the rows are shared through the static tables.
  for (String authority : new String[] { "sms", "mms", "mms-sms" }) {
   ProviderInfo info = new ProviderInfo();
   info.authority = authority;
   Robolectric.buildContentProvider(Provider.class).create(info);
  }
 }
 static void sms(long id, long thread, long date, String body) {
  add("sms", row("_id", id, "thread_id", thread, "address", "+15555550100", "body", body, "date", date, "type", SmsRecords.INBOX, "status", -1, "read", 1, "sub_id", 1));
 }
 static void incomplete(JSONObject row, String id, String reason, int keys) {
  require(row.optString("id").equals(id), id + " in page order");
  require(row.optBoolean("incomplete") && row.optString("reason").equals(reason), id + " is " + reason);
  require(row.length() == keys && !row.has("body") && !row.has("addresses") && !row.has("snippet"), id + " carries no content");
 }

 @Test public void oneLongSmsLeavesTheRestOfTheConversationReadable() throws Exception {
  sms(3, 4, 3000, "see you soon");
  sms(2, 4, 2000, "x".repeat(2500));
  sms(1, 4, 1000, "hello");
  JSObject page = SmsProviderReader.messages(RuntimeEnvironment.getApplication(), 4, 50, 0, null, new CancellationSignal());
  JSONArray rows = page.getJSONArray("messages");
  require(rows.length() == 3, "every row reported");
  require(rows.getJSONObject(0).getString("body").equals("see you soon"), "newer row readable");
  incomplete(rows.getJSONObject(1), "sms:2", "body-too-long", 6);
  require(rows.getJSONObject(1).getString("threadId").equals("thread:4") && rows.getJSONObject(1).getLong("date") == 2000, "keeps thread and date");
  require(rows.getJSONObject(2).getString("body").equals("hello"), "older row readable");
  require(page.isNull("next"), "no further page");

  // The cursor advances past the incomplete row.
  JSObject first = SmsProviderReader.messages(RuntimeEnvironment.getApplication(), 4, 2, 0, null, new CancellationSignal());
  require(first.getString("next").equals("2000:sms:2"), "cursor at the incomplete row");
  JSObject second = SmsProviderReader.messages(RuntimeEnvironment.getApplication(), 4, 2, 0, SmsPageCursor.parse(first.getString("next"), false), new CancellationSignal());
  JSONArray rest = second.getJSONArray("messages");
  require(rest.length() == 1 && rest.getJSONObject(0).getString("id").equals("sms:1"), "next page goes on");
 }

 @Test public void aGroupOverTheAddressBoundIsAnIncompleteThread() throws Exception {
  StringBuilder members = new StringBuilder();
  for (int i = 10; i < 31; i++) members.append(i == 10 ? "" : " ").append(i);
  add("conversations", row("_id", 5L, "date", 5000L, "message_count", 3, "recipient_ids", members.toString(), "snippet", "group", "read", 1));
  add("conversations", row("_id", 4L, "date", 4000L, "message_count", 2, "recipient_ids", "1", "snippet", "hi", "read", 0));
  add("canonical", row("_id", 1L, "address", "+15555550100"));
  JSObject page = SmsProviderReader.threads(RuntimeEnvironment.getApplication(), 50, 0, null, new CancellationSignal());
  JSONArray rows = page.getJSONArray("threads");
  require(rows.length() == 2, "both threads reported");
  incomplete(rows.getJSONObject(0), "thread:5", "too-many-addresses", 4);
  require(rows.getJSONObject(0).getLong("date") == 5000, "keeps date");
  JSONObject thread = rows.getJSONObject(1);
  require(thread.getString("id").equals("thread:4") && thread.getJSONArray("addresses").getString(0).equals("+15555550100"), "small thread readable");
  require(thread.getBoolean("unread") && thread.getString("snippet").equals("hi"), "small thread complete");
 }

 @Test public void anMmsWithTooManyPartsIsIncomplete() throws Exception {
  add("mms", row("_id", 7L, "thread_id", 6L, "date", 7L, "msg_box", SmsRecords.INBOX, "read", 1, "sub_id", 1));
  add("mms", row("_id", 8L, "thread_id", 6L, "date", 8L, "msg_box", SmsRecords.INBOX, "read", 1, "sub_id", 1));
  for (int i = 0; i < 33; i++) add("part:7", row("_id", (long) i, "ct", "text/plain", "text", "part " + i));
  add("part:8", row("_id", 40L, "ct", "text/plain", "text", "photo later"));
  add("part:8", row("_id", 41L, "ct", "image/jpeg"));
  add("addr:8", row("address", "+15555550101", "type", 137));
  add("addr:8", row("address", "insert-address-token", "type", 151));
  JSObject page = SmsProviderReader.messages(RuntimeEnvironment.getApplication(), 6, 50, 0, null, new CancellationSignal());
  JSONArray rows = page.getJSONArray("messages");
  require(rows.length() == 2, "both messages reported");
  JSONObject readable = rows.getJSONObject(0);
  require(readable.getString("id").equals("mms:8") && readable.getString("body").equals("photo later") && readable.getInt("attachments") == 1, "small MMS readable");
  require(readable.getJSONArray("addresses").length() == 1 && readable.getJSONArray("addresses").getString(0).equals("+15555550101"), "sender only");
  incomplete(rows.getJSONObject(1), "mms:7", "too-many-parts", 6);
  require(rows.getJSONObject(1).getString("kind").equals("mms") && rows.getJSONObject(1).getLong("date") == 7000, "keeps kind and date");
 }

 @Test public void anUnavailableProviderStillFailsTheRead() {
  ProviderInfo info = new ProviderInfo();
  info.authority = "sms";
  Robolectric.buildContentProvider(Missing.class).create(info);
  try { SmsProviderReader.messages(RuntimeEnvironment.getApplication(), 4, 50, 0, null, new CancellationSignal()); }
  catch (IllegalStateException expected) { return; }
  throw new AssertionError("an unavailable provider is not an empty page");
 }
 public static final class Missing extends ContentProvider {
  @Override public boolean onCreate() { return true; }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) { return null; }
  @Override public String getType(Uri uri) { return null; }
  @Override public Uri insert(Uri uri, ContentValues values) { return null; }
  @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
 }
}

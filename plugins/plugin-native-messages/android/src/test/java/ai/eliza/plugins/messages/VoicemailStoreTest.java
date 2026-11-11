package ai.eliza.plugins.messages;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.VoicemailContract;

import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
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
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/**
 * VoicemailStore against fake voicemail and call-log providers: the carrier state from the sources'
 * status rows, the bounded list and its row mapping, audio bounds, the fetch request and the writes.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class VoicemailStoreTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 static final String PHONE = "com.android.phone/com.android.services.telephony.TelephonyConnectionService";

 /** Rows by table: "status", "voicemail", "calls". Audio bytes by voicemail row. */
 static final Map<String, List<Map<String, Object>>> tables = new HashMap<>();
 static final Map<Long, byte[]> audio = new HashMap<>();
 static Map<String, Object> row(Object... pairs) {
  Map<String, Object> row = new HashMap<>();
  for (int i = 0; i < pairs.length; i += 2) row.put((String) pairs[i], pairs[i + 1]);
  return row;
 }
 static void add(String table, Map<String, Object> row) { tables.computeIfAbsent(table, k -> new ArrayList<>()).add(row); }

 public static final class Provider extends ContentProvider {
  private List<Map<String, Object>> matching(Uri uri) {
   List<String> path = uri.getPathSegments();
   List<Map<String, Object>> out = new ArrayList<>();
   for (Map<String, Object> r : tables.getOrDefault(path.get(0), new ArrayList<>()))
    if (path.size() == 1 || String.valueOf(r.get("_id")).equals(path.get(1))) out.add(r);
   return out;
  }
  @Override public boolean onCreate() { return true; }
  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
   MatrixCursor cursor = new MatrixCursor(projection);
   for (Map<String, Object> r : matching(uri)) {
    if (selection != null && selection.contains("deleted = 0") && Integer.valueOf(1).equals(r.get("deleted"))) continue;
    Object[] values = new Object[projection.length];
    for (int i = 0; i < projection.length; i++) values[i] = r.get(projection[i]);
    cursor.addRow(values);
   }
   return cursor;
  }
  @Override public String getType(Uri uri) { return null; }
  @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  @Override public int delete(Uri uri, String selection, String[] args) {
   List<Map<String, Object>> found = matching(uri);
   tables.get(uri.getPathSegments().get(0)).removeAll(found);
   return found.size();
  }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
   List<Map<String, Object>> found = matching(uri);
   for (Map<String, Object> r : found) for (String key : values.keySet()) r.put(key, values.get(key));
   return found.size();
  }
  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
   byte[] bytes = audio.get(Long.parseLong(uri.getLastPathSegment()));
   if (bytes == null) throw new java.io.FileNotFoundException();
   try {
    File file = File.createTempFile("voicemail", ".amr", getContext().getCacheDir());
    try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); }
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
   } catch (java.io.IOException failed) { throw new java.io.FileNotFoundException(); }
  }
 }

 final Context context = RuntimeEnvironment.getApplication();
 @Before public void providers() {
  tables.clear(); audio.clear();
  for (String authority : new String[] { VoicemailContract.AUTHORITY, "call_log" }) {
   ProviderInfo info = new ProviderInfo();
   info.authority = authority;
   Robolectric.buildContentProvider(Provider.class).create(info);
  }
 }
 static void source(String account, int configuration) {
  add("status", row("phone_account_component_name", account == null ? null : PHONE, "phone_account_id", account, "configuration_state", configuration));
 }
 static void voicemail(long id, long date, Object... more) {
  Map<String, Object> r = row("_id", id, "number", "+1 (555) 555-0100", "date", date, "duration", 12L, "is_read", 0, "has_content", 1,
    "source_package", "com.example.vvm", "mime_type", "audio/amr", "deleted", 0);
  r.putAll(row(more));
  add("voicemail", r);
 }
 static VoicemailStore.Status status(String account, int configuration) { return new VoicemailStore.Status(account == null ? null : PHONE, account, configuration); }

 @Test public void carrierStateComesOnlyFromTheSourcesOfTheCallingAccount() {
  require(VoicemailStore.state(Arrays.asList(), PHONE, "1").equals("unsupported"), "no source is unsupported");
  require(VoicemailStore.state(Arrays.asList(status("1", 0)), PHONE, "1").equals("ready"), "configured source");
  require(VoicemailStore.state(Arrays.asList(status("1", 0)), "com.android.phone/.TelephonyConnectionService", "1").equals("unsupported"), "another component's account");
  require(VoicemailStore.state(Arrays.asList(new VoicemailStore.Status("com.android.phone/com.android.services.telephony.TelephonyConnectionService", "1", 0)),
    "com.android.phone/com.android.services.telephony.TelephonyConnectionService", "1").equals("ready"), "same component");
  for (int pending = 1; pending <= 4; pending++) require(VoicemailStore.state(Arrays.asList(status("1", pending)), PHONE, "1").equals("unconfigured"), "state " + pending + " is unconfigured");
  require(VoicemailStore.state(Arrays.asList(status("1", 5)), PHONE, "1").equals("unsupported"), "a disabled source is unsupported");
  require(VoicemailStore.state(Arrays.asList(status("1", 99)), PHONE, "1").equals("unsupported"), "an unknown state is never ready");
  require(VoicemailStore.state(Arrays.asList(status("2", 0)), PHONE, "1").equals("unsupported"), "another SIM's source does not count");
  require(VoicemailStore.state(Arrays.asList(status("2", 0), status("1", 1)), PHONE, "1").equals("unconfigured"), "only this SIM's source counts");
  require(VoicemailStore.state(Arrays.asList(status(null, 0)), PHONE, "1").equals("ready"), "a source that names no account counts");
  require(VoicemailStore.state(Arrays.asList(status("2", 0)), null, null).equals("ready"), "with no known calling account every source counts");

  require(VoicemailStore.row("12") == 12 && VoicemailStore.row("0") == -1 && VoicemailStore.row("012") == -1 && VoicemailStore.row("1x") == -1 && VoicemailStore.row(null) == -1, "ids");
  require(VoicemailStore.row("1234567890123456789") == -1, "an id too long for a row");
  require(VoicemailStore.limit(1) == 1 && VoicemailStore.limit(50) == 50 && VoicemailStore.limit(0) == -1 && VoicemailStore.limit(51) == -1 && VoicemailStore.limit(null) == -1, "limits");
 }

 @Test public void anUnsupportedCarrierIsAnEmptyListWithItsStateNotAnError() throws Exception {
  voicemail(9, 9000);
  JSObject none = VoicemailStore.list(context, 50, PHONE, "1", false, new CancellationSignal());
  require(none.getString("state").equals("unsupported") && none.getJSONArray("voicemails").length() == 0, "no source: unsupported and nothing read");
  require(VoicemailStore.carrierState(context, PHONE, "1", new CancellationSignal()).equals("unsupported"), "status agrees");
  source("1", 1);
  JSObject pending = VoicemailStore.list(context, 50, PHONE, "1", false, new CancellationSignal());
  require(pending.getString("state").equals("unconfigured") && pending.getJSONArray("voicemails").length() == 1, "an unconfigured source's stored rows are still listed");
 }

 @Test public void rowsAreMappedBoundedAndNewestFirst() throws Exception {
  source("1", 0);
  voicemail(3, 3000, "transcription", "Call me back", "has_content", 0);
  voicemail(2, 2000, "number", null, "is_read", 1, "transcription", "x".repeat(4001), "duration", -4L);
  voicemail(1, 1000, "transcription", "  ");
  voicemail(7, 2500, "deleted", 1);
  add("calls", row("voicemail_uri", "content://com.android.voicemail/voicemail/3", "name", " Ada "));
  add("calls", row("voicemail_uri", "content://elsewhere/voicemail/2", "name", "Wrong provider"));
  add("calls", row("voicemail_uri", "content://com.android.voicemail/voicemail/1", "name", "y".repeat(257)));

  JSObject page = VoicemailStore.list(context, 50, PHONE, "1", true, new CancellationSignal());
  require(page.getString("state").equals("ready"), "ready");
  JSONArray rows = page.getJSONArray("voicemails");
  require(rows.length() == 3, "deleted row left out");
  JSONObject first = rows.getJSONObject(0);
  require(first.length() == 8, "exactly the contract's fields");
  require(first.getString("id").equals("3") && first.getString("number").equals("+15555550100") && first.getLong("date") == 3000, "id, dial-shape number, date");
  require(first.getString("cachedName").equals("Ada") && first.getBoolean("isNew") && !first.getBoolean("hasAudio"), "name, new, no audio yet");
  require(first.getInt("durationSeconds") == 12 && first.getString("carrierTranscript").equals("Call me back"), "duration and transcript");
  JSONObject second = rows.getJSONObject(1);
  require(second.getString("number").isEmpty() && second.isNull("cachedName") && !second.getBoolean("isNew") && second.getBoolean("hasAudio"), "withheld, heard, audio stored");
  require(second.isNull("carrierTranscript") && second.getInt("durationSeconds") == 0, "an over-long transcript is not clipped; duration never negative");
  require(rows.getJSONObject(2).isNull("carrierTranscript") && rows.getJSONObject(2).isNull("cachedName"), "blank transcript and over-long name are null");

  JSONArray unnamed = VoicemailStore.list(context, 2, PHONE, "1", false, new CancellationSignal()).getJSONArray("voicemails");
  require(unnamed.length() == 2 && unnamed.getJSONObject(0).isNull("cachedName"), "bounded; no call-log read without access");
 }

 @Test public void anUnusableRowFailsTheReadInsteadOfBeingSkipped() {
  source("1", 0);
  voicemail(1, 1000);
  voicemail(2, 2000);
  try { VoicemailStore.list(context, 50, PHONE, "1", false, new CancellationSignal()); }
  catch (IllegalStateException expected) { return; }
  throw new AssertionError("rows out of order are not published");
 }

 @Test public void audioIsWholeTypedAndBounded() throws Exception {
  voicemail(1, 1000);
  voicemail(2, 2000, "has_content", 0);
  voicemail(3, 3000);
  voicemail(4, 4000, "mime_type", "text/html");
  audio.put(1L, new byte[] { 35, 33, 65, 77, 82, 10 });
  audio.put(3L, new byte[VoicemailStore.MAX_AUDIO_BYTES + 1]);
  audio.put(4L, new byte[] { 1 });
  JSObject value = VoicemailStore.audio(context, 1, new CancellationSignal());
  require(value.getString("id").equals("1") && value.getString("mimeType").equals("audio/amr") && value.getInt("size") == 6, "id, type and size");
  require(value.getString("data").equals("IyFBTVIK"), "the exact bytes in base64");
  require(refusal(() -> VoicemailStore.audio(context, 2, new CancellationSignal())).equals("not-ready"), "audio not downloaded yet");
  require(refusal(() -> VoicemailStore.audio(context, 3, new CancellationSignal())).equals("too-large"), "over the bound is refused, not clipped");
  require(refusal(() -> VoicemailStore.audio(context, 8, new CancellationSignal())).equals("not-found"), "no such voicemail");
  require(refusal(() -> VoicemailStore.pcm(context, 2, new CancellationSignal())).equals("not-ready"), "nothing to decode yet");
  require(refusal(() -> VoicemailStore.pcm(context, 8, new CancellationSignal())).equals("not-found"), "nothing to decode");
  try { VoicemailStore.audio(context, 4, new CancellationSignal()); }
  catch (IllegalStateException expected) { return; }
  throw new AssertionError("a non-audio type is not published");
 }
 interface Attempt { Object run() throws Exception; }
 static String refusal(Attempt attempt) throws Exception {
  try { attempt.run(); } catch (VoicemailStore.Refused refused) { return refused.code; }
  throw new AssertionError("expected a typed refusal");
 }

 @Test public void fetchAsksOnlyTheRowsOwnSource() throws Exception {
  voicemail(1, 1000);
  voicemail(2, 2000, "has_content", 0);
  voicemail(3, 3000, "has_content", 0, "source_package", null);
  require(VoicemailStore.fetch(context, 1, new CancellationSignal()).equals("ready"), "already stored");
  require(Shadows.shadowOf(RuntimeEnvironment.getApplication()).getBroadcastIntents().isEmpty(), "no request for stored audio");
  require(VoicemailStore.fetch(context, 2, new CancellationSignal()).equals("fetching"), "requested");
  List<Intent> sent = Shadows.shadowOf(RuntimeEnvironment.getApplication()).getBroadcastIntents();
  require(sent.size() == 1 && VoicemailContract.ACTION_FETCH_VOICEMAIL.equals(sent.get(0).getAction()), "one fetch request");
  require("com.example.vvm".equals(sent.get(0).getPackage()) && sent.get(0).getData().toString().equals("content://com.android.voicemail/voicemail/2"), "to the source, for this voicemail");
  require(VoicemailStore.fetch(context, 3, new CancellationSignal()).equals("failed"), "no source to ask");
  require(refusal(() -> VoicemailStore.fetch(context, 8, new CancellationSignal())).equals("not-found"), "no such voicemail");
 }

 @Test public void heardAndDeleteReportWhetherTheRowExisted() throws Exception {
  source("1", 0);
  voicemail(2, 2000);
  voicemail(1, 1000);
  require(VoicemailStore.markHeard(context, 2) && !VoicemailStore.markHeard(context, 8), "heard only for a stored row");
  JSONArray rows = VoicemailStore.list(context, 50, PHONE, "1", false, new CancellationSignal()).getJSONArray("voicemails");
  require(!rows.getJSONObject(0).getBoolean("isNew") && rows.getJSONObject(1).getBoolean("isNew"), "only that row is heard");
  require(VoicemailStore.delete(context, 2) && !VoicemailStore.delete(context, 2), "deleted once");
  require(VoicemailStore.list(context, 50, PHONE, "1", false, new CancellationSignal()).getJSONArray("voicemails").length() == 1, "the other row stays");
 }
}

package ai.eliza.plugins.messages;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.CallLog;
import android.provider.VoicemailContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Bounded reads and owner-driven writes of Android's voicemail provider
 * ({@link VoicemailContract}), which holds what a visual-voicemail source on the phone stored. The
 * default dialer (or a holder of READ_VOICEMAIL / WRITE_VOICEMAIL) sees every source's rows.
 *
 * The carrier state comes only from the sources' {@link VoicemailContract.Status} rows for the
 * default calling account: no row, or only disabled ones, is {@link #UNSUPPORTED}, and then no
 * voicemail row is read, so "this carrier has no visual voicemail" is never shown as "no voicemail".
 * A list holds at most {@link #MAX_VOICEMAILS} newest rows; a row with an unusable ID, date or order
 * fails the read instead of being skipped. Audio is returned whole or not at all (at most
 * {@link #MAX_AUDIO_BYTES}). A carrier transcript longer than {@link #MAX_TRANSCRIPT} characters is
 * not published (null), never clipped. Nothing here downloads from the carrier: {@link #fetch} only
 * asks the row's own source to (the {@code vvm} package is such a source when the host declares it).
 */
@androidx.annotation.RequiresApi(29)
public final class VoicemailStore {
 private VoicemailStore() {}
 public static final int MAX_VOICEMAILS = 50, MAX_AUDIO_BYTES = 8 * 1024 * 1024, MAX_TRANSCRIPT = 4000, MAX_STATUS_ROWS = 32, MAX_NAME = 256;
 public static final String READY = "ready", UNCONFIGURED = "unconfigured", UNSUPPORTED = "unsupported";
 private static final Pattern ID = Pattern.compile("^[1-9][0-9]{0,17}$");
 private static final Pattern AUDIO_TYPE = Pattern.compile("^audio/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$");
 /** Call-log rows read to find the names Android cached for voicemail callers. */
 private static final int MAX_NAME_ROWS = 200;

 /** A request the store answers with a typed reason instead of a result. */
 public static final class Refused extends Exception {
  private static final long serialVersionUID = 1L;
  public final String code;
  Refused(String code, String message) { super(message, null, false, false); this.code = code; }
 }
 static Refused notFound() { return new Refused("not-found", "No voicemail with this ID"); }

 /** The provider row of a renderer voicemail ID, or -1 when it is not one. */
 public static long row(String id) { return id != null && ID.matcher(id).matches() ? Long.parseLong(id) : -1; }
 /** A page size of 1..{@link #MAX_VOICEMAILS}, or -1 when the request is outside it. */
 public static int limit(Integer requested) { return requested == null || requested < 1 || requested > MAX_VOICEMAILS ? -1 : requested; }

 /** One source's status row: the calling account it is for (null on sources that name none) and its configuration state. */
 public static final class Status {
  final String component, account; final int configuration;
  public Status(String component, String account, int configuration) { this.component = component; this.account = account; this.configuration = configuration; }
 }
 /**
  * The carrier state of one calling account from the sources' status rows. A row counts when it
  * names that account or names none; with no known account ({@code component} null) every row
  * counts. Ready when a counted source is configured; unconfigured when one could be, is being, or
  * failed to be configured; unsupported when none exists or every one is disabled.
  */
 public static String state(Iterable<Status> rows, String component, String account) {
  boolean pending = false;
  for (Status row : rows) {
   if (component != null && row.account != null && !(account != null && account.equals(row.account) && (row.component == null || sameComponent(component, row.component)))) continue;
   if (row.configuration == VoicemailContract.Status.CONFIGURATION_STATE_OK) return READY;
   if (row.configuration >= VoicemailContract.Status.CONFIGURATION_STATE_NOT_CONFIGURED && row.configuration <= 4 /* CONFIGURATION_STATE_FAILED */) pending = true;
  }
  return pending ? UNCONFIGURED : UNSUPPORTED;
 }
 /** Sources store the component flattened in full or short form; both name the same component. */
 private static boolean sameComponent(String a, String b) {
  android.content.ComponentName x = android.content.ComponentName.unflattenFromString(a), y = android.content.ComponentName.unflattenFromString(b);
  return x != null && x.equals(y);
 }

 /** Reads the status rows and reduces them with {@link #state}. More rows than {@link #MAX_STATUS_ROWS} fail the read. */
 public static String carrierState(Context context, String component, String account, CancellationSignal cancel) {
  java.util.List<Status> rows = new java.util.ArrayList<>();
  String[] projection = { VoicemailContract.Status.PHONE_ACCOUNT_COMPONENT_NAME, VoicemailContract.Status.PHONE_ACCOUNT_ID, VoicemailContract.Status.CONFIGURATION_STATE };
  try (Cursor cursor = context.getContentResolver().query(VoicemailContract.Status.CONTENT_URI, projection, null, null, null, cancel)) {
   if (cursor == null) throw new IllegalStateException("Voicemail status unavailable");
   while (cursor.moveToNext()) {
    if (rows.size() >= MAX_STATUS_ROWS) throw new IllegalStateException("Too many voicemail sources");
    // A row without a configuration state says nothing: it is read as not configured, never as ready.
    rows.add(new Status(cursor.isNull(0) ? null : cursor.getString(0), cursor.isNull(1) ? null : cursor.getString(1),
      cursor.isNull(2) ? VoicemailContract.Status.CONFIGURATION_STATE_NOT_CONFIGURED : cursor.getInt(2)));
   }
  }
  return state(rows, component, account);
 }

 /**
  * The newest voicemails with the carrier state they were read under:
  * {@code {state, voicemails: [{id, number, cachedName, date, durationSeconds, isNew, hasAudio, carrierTranscript}]}}.
  * {@code names} adds the caller names Android cached in the call log (READ_CALL_LOG); without it
  * every name is null.
  */
 public static JSObject list(Context context, int limit, String component, String account, boolean names, CancellationSignal cancel) {
  if (limit < 1 || limit > MAX_VOICEMAILS) throw new IllegalArgumentException("Invalid voicemail page");
  ContentResolver resolver = context.getContentResolver();
  JSObject value = new JSObject(); JSArray rows = new JSArray();
  String state = carrierState(context, component, account, cancel);
  value.put("state", state); value.put("voicemails", rows);
  if (UNSUPPORTED.equals(state)) return value;
  String[] projection = { VoicemailContract.Voicemails._ID, VoicemailContract.Voicemails.NUMBER, VoicemailContract.Voicemails.DATE, VoicemailContract.Voicemails.DURATION,
   VoicemailContract.Voicemails.IS_READ, VoicemailContract.Voicemails.HAS_CONTENT, VoicemailContract.Voicemails.TRANSCRIPTION };
  Map<Long, String> cached = null;
  try (Cursor cursor = resolver.query(VoicemailContract.Voicemails.CONTENT_URI, projection, VoicemailContract.Voicemails.DELETED + " = 0", null,
    VoicemailContract.Voicemails.DATE + " DESC, " + VoicemailContract.Voicemails._ID + " DESC", cancel)) {
   if (cursor == null) throw new IllegalStateException("Voicemail unavailable");
   long previous = Long.MAX_VALUE; Set<String> seen = new HashSet<>();
   while (rows.length() < limit && cursor.moveToNext()) {
    cancel.throwIfCanceled();
    String id = cursor.getString(0); long date = cursor.getLong(2);
    if (row(id) < 0 || date <= 0 || date > previous || !seen.add(id)) throw new IllegalStateException("Unreadable voicemail row");
    previous = date;
    if (names && cached == null) cached = cachedNames(resolver, cancel);
    String name = cached == null ? null : cached.get(Long.parseLong(id));
    String transcript = cursor.isNull(6) ? null : cursor.getString(6);
    JSObject row = new JSObject();
    row.put("id", id);
    row.put("number", CallLogRows.number(cursor.getString(1)));
    row.put("cachedName", name == null ? JSONObject.NULL : name);
    row.put("date", date);
    row.put("durationSeconds", CallLogRows.duration(cursor.getLong(3)));
    row.put("isNew", cursor.isNull(4) || cursor.getInt(4) == 0);
    row.put("hasAudio", !cursor.isNull(5) && cursor.getInt(5) != 0);
    row.put("carrierTranscript", transcript == null || transcript.trim().isEmpty() || transcript.length() > MAX_TRANSCRIPT ? JSONObject.NULL : transcript);
    rows.put(row);
   }
  }
  return value;
 }
 /** Voicemail row → the caller name the call log cached for it; names over {@link #MAX_NAME} characters are left out. */
 private static Map<Long, String> cachedNames(ContentResolver resolver, CancellationSignal cancel) {
  Map<Long, String> names = new HashMap<>();
  Uri uri = CallLog.Calls.CONTENT_URI_WITH_VOICEMAIL.buildUpon().appendQueryParameter(CallLog.Calls.LIMIT_PARAM_KEY, String.valueOf(MAX_NAME_ROWS)).build();
  try (Cursor cursor = resolver.query(uri, new String[] { CallLog.Calls.VOICEMAIL_URI, CallLog.Calls.CACHED_NAME },
    CallLog.Calls.TYPE + " = " + CallLog.Calls.VOICEMAIL_TYPE, null, CallLog.Calls.DATE + " DESC", cancel)) {
   if (cursor == null) throw new IllegalStateException("Call log unavailable");
   int read = 0;
   while (read++ < MAX_NAME_ROWS && cursor.moveToNext()) {
    if (cursor.isNull(0) || cursor.isNull(1)) continue;
    String name = cursor.getString(1).trim(); Uri voicemail = Uri.parse(cursor.getString(0));
    if (name.isEmpty() || name.length() > MAX_NAME || !VoicemailContract.AUTHORITY.equals(voicemail.getAuthority())) continue;
    long id = row(voicemail.getLastPathSegment());
    if (id > 0) names.put(id, name);
   }
  }
  return names;
 }

 private static Uri uri(long id) { return ContentUris.withAppendedId(VoicemailContract.Voicemails.CONTENT_URI, id); }

 /**
  * Whether a voicemail's audio is on the phone: {@code "ready"} when it is, otherwise the row's own
  * source is asked to download it ({@link VoicemailContract#ACTION_FETCH_VOICEMAIL}) and the answer
  * is {@code "fetching"}, which proves only that the request was broadcast; {@code "failed"} when the
  * row names no source or the request could not be sent.
  */
 public static String fetch(Context context, long id, CancellationSignal cancel) throws Refused {
  String source;
  try (Cursor cursor = context.getContentResolver().query(uri(id), new String[] { VoicemailContract.Voicemails.HAS_CONTENT, VoicemailContract.Voicemails.SOURCE_PACKAGE },
    VoicemailContract.Voicemails.DELETED + " = 0", null, null, cancel)) {
   if (cursor == null) throw new IllegalStateException("Voicemail unavailable");
   if (!cursor.moveToFirst()) throw notFound();
   if (!cursor.isNull(0) && cursor.getInt(0) != 0) return "ready";
   source = cursor.isNull(1) ? null : cursor.getString(1);
  }
  if (source == null || source.isEmpty()) return "failed";
  try { context.sendBroadcast(new Intent(VoicemailContract.ACTION_FETCH_VOICEMAIL, uri(id)).setPackage(source)); return "fetching"; }
  catch (RuntimeException unsent) { return "failed"; }
 }

 /** The whole audio of one voicemail: {@code {id, mimeType, size, data}} with {@code data} in base64. */
 public static JSObject audio(Context context, long id, CancellationSignal cancel) throws Exception {
  ContentResolver resolver = context.getContentResolver();
  String type = stored(resolver, id, cancel);
  if (type == null || !AUDIO_TYPE.matcher(type).matches()) throw new IllegalStateException("Voicemail audio type unreadable");
  ByteArrayOutputStream bytes = new ByteArrayOutputStream();
  try (InputStream in = resolver.openInputStream(uri(id))) {
   if (in == null) throw new IllegalStateException("Voicemail audio unavailable");
   byte[] buffer = new byte[64 * 1024];
   for (int read; (read = in.read(buffer)) >= 0; ) {
    cancel.throwIfCanceled();
    if (bytes.size() + read > MAX_AUDIO_BYTES) throw new Refused("too-large", "This voicemail is too large to play here");
    bytes.write(buffer, 0, read);
   }
  }
  if (bytes.size() == 0) throw new IllegalStateException("Voicemail audio empty");
  JSObject value = new JSObject();
  value.put("id", String.valueOf(id)); value.put("mimeType", type); value.put("size", bytes.size());
  value.put("data", java.util.Base64.getEncoder().encodeToString(bytes.toByteArray()));
  return value;
 }

 /** The stored MIME type (possibly null) of a voicemail whose audio is on the phone; refuses "not-found" or "not-ready". */
 private static String stored(ContentResolver resolver, long id, CancellationSignal cancel) throws Refused {
  try (Cursor cursor = resolver.query(uri(id), new String[] { VoicemailContract.Voicemails.HAS_CONTENT, VoicemailContract.Voicemails.MIME_TYPE },
    VoicemailContract.Voicemails.DELETED + " = 0", null, null, cancel)) {
   if (cursor == null) throw new IllegalStateException("Voicemail unavailable");
   if (!cursor.moveToFirst()) throw notFound();
   if (cursor.isNull(0) || cursor.getInt(0) == 0) throw new Refused("not-ready", "This voicemail's audio is not on the phone yet");
   return cursor.isNull(1) ? null : cursor.getString(1);
  }
 }
 /** One voicemail decoded to 16 kHz mono PCM16 WAV for on-device transcription; see {@link VoicemailPcm#decode}. */
 public static JSObject pcm(Context context, long id, CancellationSignal cancel) throws Refused {
  stored(context.getContentResolver(), id, cancel);
  return VoicemailPcm.decode(context, uri(id), cancel);
 }

 /**
  * Whether a stored voicemail was written by this app's own visual-voicemail client; null when no such voicemail exists.
  * Android marks a row dirty or deleted for its source only when another app changes it, so for its own rows the app
  * sets those columns itself and then asks its client to sync ({@link VoicemailContract#ACTION_SYNC_VOICEMAIL}).
  */
 private static Boolean own(Context context, long id) {
  try (Cursor cursor = context.getContentResolver().query(uri(id), new String[] { VoicemailContract.Voicemails.SOURCE_PACKAGE }, VoicemailContract.Voicemails.DELETED + " = 0", null, null)) {
   if (cursor == null || !cursor.moveToFirst()) return null;
   return !cursor.isNull(0) && context.getPackageName().equals(cursor.getString(0));
  }
 }
 private static void requestSync(Context context) {
  try { context.sendBroadcast(new Intent(VoicemailContract.ACTION_SYNC_VOICEMAIL).setPackage(context.getPackageName())); }
  catch (RuntimeException unsent) { /* the next sync pushes the change */ }
 }

 /** Marks one voicemail heard, dirty for its source to sync; false when no such voicemail exists. */
 public static boolean markHeard(Context context, long id) {
  Boolean own = own(context, id);
  if (own == null) return false;
  ContentValues values = new ContentValues(); values.put(VoicemailContract.Voicemails.IS_READ, 1); values.put(VoicemailContract.Voicemails.DIRTY, 1);
  boolean changed = context.getContentResolver().update(uri(id), values, null, null) > 0;
  if (changed && own) requestSync(context);
  return changed;
 }
 /**
  * Deletes one voicemail; false when no such voicemail exists. Another source's row is deleted through the provider,
  * which keeps it as deleted for that source to sync. This app's own row is marked deleted and dirty (it leaves every
  * list at once) and its client removes it from the carrier and then from the phone.
  */
 public static boolean delete(Context context, long id) {
  Boolean own = own(context, id);
  if (own == null) return false;
  if (!own) return context.getContentResolver().delete(uri(id), null, null) > 0;
  ContentValues values = new ContentValues(); values.put(VoicemailContract.Voicemails.DELETED, 1); values.put(VoicemailContract.Voicemails.DIRTY, 1);
  boolean changed = context.getContentResolver().update(uri(id), values, null, null) > 0;
  if (changed) requestSync(context);
  return changed;
 }
}

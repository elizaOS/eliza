package ai.eliza.plugins.messages.vvm;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.VoicemailContract.Voicemails;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * One two-way reconcile between a carrier IMAP mailbox and this source's rows in the voicemail
 * provider for one calling account. A row's {@code source_data} is the message's IMAP UID.
 *
 * In order: what the owner did on the phone is pushed (rows the provider holds as deleted are
 * flagged \Deleted, expunged and then removed; rows marked dirty and read are flagged \Seen);
 * the server's state is pulled (rows whose message is gone are removed, messages seen elsewhere are
 * marked read); new messages with an audio part become rows; and last, audio is downloaded for the
 * one requested row and, with prefetch, for rows without it. Downloads come last so that a message
 * whose audio cannot be taken never stops the mailbox from being reconciled.
 *
 * A changed UIDVALIDITY means the stored UIDs name nothing: the account's rows are dropped and
 * read again, and nothing local is pushed. Every step is bounded; what a bound leaves undone is
 * done by a later sync, never by repeating this one.
 */
@androidx.annotation.RequiresApi(29)
final class VvmSync {
 private VvmSync() {}
 static final int MAX_LOCAL = 4000, MAX_NEW = 100, MAX_DOWNLOADS = 20, FETCH_BATCH = 100, MAX_DEPTH = 8;
 /** The largest audio stored, matching what the reader will return (VoicemailStore.MAX_AUDIO_BYTES). */
 static final int MAX_AUDIO_BYTES = 8 * 1024 * 1024;
 static final String INBOX = "INBOX", SEEN = "\\seen", DELETED = "\\deleted";
 private static final Pattern AUDIO_TYPE = Pattern.compile("^audio/[a-z0-9][a-z0-9.+-]{0,63}$");
 private static final Pattern PHONE = Pattern.compile("\\+?[0-9*#]{1,32}");

 static final class Result {
  /** The mailbox generation synced against, or -1 when the server named none. */
  long uidValidity = -1;
  /** {@code {used, total}} when the server reports a storage quota. */
  long[] quota;
  int inserted, removed, downloaded;
 }

 private static final class Row { long id, uid; boolean read, dirty, deleted, hasContent; }
 /** The audio part of a message: its body section, MIME type, transfer encoding and size as sent. */
 static final class Part {
  final String section, mimeType, encoding; final long size;
  Part(String section, String mimeType, String encoding, long size) { this.section = section; this.mimeType = mimeType; this.encoding = encoding; this.size = size; }
 }

 /**
  * Logs in and reconciles. {@code fetchRow} is a row whose audio was asked for, or -1.
  * The caller owns the session and closes it.
  */
 static Result run(Context context, VvmAccount account, VvmAccount.Credentials credentials, CarrierVvm carrier, ImapClient imap, long fetchRow) throws IOException {
  ContentResolver resolver = context.getContentResolver();
  Result result = new Result();
  imap.login(credentials.user, credentials.password);
  Set<String> capabilities = imap.capability();
  capabilities.removeAll(carrier.disabledCapabilities);
  result.uidValidity = imap.select(INBOX);

  Map<Long, Row> local = local(context, account);
  if (credentials.uidValidity != -1 && result.uidValidity != credentials.uidValidity && !local.isEmpty()) {
   VvmProvider.deleteVoicemails(context, account);
   result.removed += local.size();
   local.clear();
  }

  // The server's messages and their flags. A message already flagged \Deleted is as good as gone.
  List<Long> uids = imap.uidSearchAll();
  Map<Long, Boolean> seen = new HashMap<>();
  for (int from = 0; from < uids.size(); from += FETCH_BATCH)
   for (ImapClient.Fetched message : imap.uidFetch(uids.subList(from, Math.min(uids.size(), from + FETCH_BATCH)), "UID FLAGS")) {
    Set<String> flags = message.flags();
    if (message.uid() > 0 && !flags.contains(DELETED)) seen.put(message.uid(), flags.contains(SEEN));
   }

  // Push: the owner's deletions, then the owner's "heard".
  List<Long> expunge = new ArrayList<>(), markSeen = new ArrayList<>();
  List<Row> deleted = new ArrayList<>(), pushed = new ArrayList<>();
  for (Row row : local.values()) {
   if (row.deleted) { deleted.add(row); if (seen.containsKey(row.uid)) expunge.add(row.uid); }
   else if (row.dirty) { pushed.add(row); if (row.read && Boolean.FALSE.equals(seen.get(row.uid))) markSeen.add(row.uid); }
  }
  if (!expunge.isEmpty()) { imap.addFlag(expunge, "\\Deleted"); imap.expunge(expunge, capabilities.contains("UIDPLUS")); }
  for (Row row : deleted) { resolver.delete(VvmProvider.voicemail(context, row.id), null, null); local.remove(row.uid); seen.remove(row.uid); result.removed++; }
  if (!markSeen.isEmpty()) { imap.addFlag(markSeen, "\\Seen"); for (long uid : markSeen) seen.put(uid, true); }
  for (Row row : pushed) {
   // Only a row still as it was read is settled; one the owner changed meanwhile stays dirty for the next sync.
   ContentValues clean = new ContentValues(); clean.put(Voicemails.DIRTY, 0);
   resolver.update(VvmProvider.voicemail(context, row.id), clean, Voicemails.IS_READ + " = ? AND " + Voicemails.DELETED + " = ?", new String[] { row.read ? "1" : "0", "0" });
  }

  // Pull: rows whose message is gone, and messages heard elsewhere.
  for (Row row : new ArrayList<>(local.values())) {
   Boolean serverSeen = seen.get(row.uid);
   if (serverSeen == null) { resolver.delete(VvmProvider.voicemail(context, row.id), null, null); local.remove(row.uid); result.removed++; }
   else if (serverSeen && !row.read) {
    ContentValues read = new ContentValues(); read.put(Voicemails.IS_READ, 1); read.put(Voicemails.DIRTY, 0);
    resolver.update(VvmProvider.voicemail(context, row.id), read, null, null);
    row.read = true;
   }
  }

  // New messages, newest first, at most MAX_NEW in one sync.
  Map<Long, Part> parts = new HashMap<>();
  List<Long> unknown = new ArrayList<>();
  for (long uid : seen.keySet()) if (!local.containsKey(uid)) unknown.add(uid);
  Collections.sort(unknown, Collections.reverseOrder());
  if (unknown.size() > MAX_NEW) unknown = unknown.subList(0, MAX_NEW);
  for (int from = 0; from < unknown.size(); from += FETCH_BATCH)
   for (ImapClient.Fetched message : imap.uidFetch(unknown.subList(from, Math.min(unknown.size(), from + FETCH_BATCH)),
     "UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (CONTENT-DURATION)]")) {
    long uid = message.uid();
    Part part = audioPart(message.items.get("BODYSTRUCTURE"));
    long date = date(message);
    if (uid <= 0 || !unknown.contains(uid) || local.containsKey(uid) || part == null || date <= 0) continue; // not a voicemail this client can show
    ContentValues values = new ContentValues();
    values.put(Voicemails.SOURCE_PACKAGE, context.getPackageName());
    values.put(Voicemails.SOURCE_DATA, String.valueOf(uid));
    values.put(Voicemails.PHONE_ACCOUNT_COMPONENT_NAME, account.component);
    values.put(Voicemails.PHONE_ACCOUNT_ID, account.id);
    values.put(Voicemails.NUMBER, sender(message.items.get("ENVELOPE")));
    values.put(Voicemails.DATE, date);
    values.put(Voicemails.DURATION, duration(message));
    values.put(Voicemails.IS_READ, message.flags().contains(SEEN) ? 1 : 0);
    values.put(Voicemails.IS_OMTP_VOICEMAIL, 1);
    Uri inserted = resolver.insert(VvmProvider.voicemails(context), values);
    long id = inserted == null ? -1 : ImapClient.positive(inserted.getLastPathSegment());
    if (id <= 0) throw new IOException("Voicemail row not stored");
    Row row = new Row(); row.id = id; row.uid = uid; row.read = message.flags().contains(SEEN);
    local.put(uid, row); parts.put(uid, part); result.inserted++;
   }

  if (capabilities.contains("QUOTA")) {
   try { result.quota = imap.quota(INBOX); }
   catch (ImapClient.ImapException refused) { if (refused.failure != ImapClient.Failure.REFUSED) throw refused; }
  }

  // Audio: the requested row first, then (with prefetch) the newest rows that have none.
  List<Row> wanted = new ArrayList<>();
  for (Row row : local.values()) if (row.id == fetchRow && !row.hasContent) wanted.add(row);
  if (carrier.prefetch) {
   List<Row> rest = new ArrayList<>();
   for (Row row : local.values()) if (!row.hasContent && row.id != fetchRow) rest.add(row);
   Collections.sort(rest, (a, b) -> Long.compare(b.uid, a.uid));
   wanted.addAll(rest);
  }
  if (wanted.size() > MAX_DOWNLOADS) wanted = wanted.subList(0, MAX_DOWNLOADS);
  for (Row row : wanted) {
   Part part = parts.get(row.uid);
   if (part == null) for (ImapClient.Fetched message : imap.uidFetch(Collections.singletonList(row.uid), "UID BODYSTRUCTURE"))
    if (message.uid() == row.uid) part = audioPart(message.items.get("BODYSTRUCTURE"));
   if (part != null && download(context, imap, row, part)) result.downloaded++;
  }
  imap.logout();
  return result;
 }

 /** This account's rows by UID. A row without a usable UID, or a second row for one UID, is not this client's and is removed. */
 private static Map<Long, Row> local(Context context, VvmAccount account) throws IOException {
  ContentResolver resolver = context.getContentResolver();
  Map<Long, Row> rows = new HashMap<>();
  List<Long> strays = new ArrayList<>();
  String[] projection = { Voicemails._ID, Voicemails.SOURCE_DATA, Voicemails.IS_READ, Voicemails.DIRTY, Voicemails.DELETED, Voicemails.HAS_CONTENT };
  try (Cursor cursor = resolver.query(VvmProvider.voicemails(context), projection, VvmProvider.VOICEMAIL_ACCOUNT, VvmProvider.account(account), null)) {
   if (cursor == null) throw new IOException("Voicemail provider unavailable");
   while (cursor.moveToNext()) {
    if (rows.size() + strays.size() >= MAX_LOCAL) throw new IOException("Too many voicemail rows");
    Row row = new Row();
    row.id = cursor.getLong(0);
    row.uid = cursor.isNull(1) ? -1 : ImapClient.positive(cursor.getString(1));
    row.read = !cursor.isNull(2) && cursor.getInt(2) != 0;
    row.dirty = !cursor.isNull(3) && cursor.getInt(3) != 0;
    row.deleted = !cursor.isNull(4) && cursor.getInt(4) != 0;
    row.hasContent = !cursor.isNull(5) && cursor.getInt(5) != 0;
    if (row.uid <= 0 || rows.containsKey(row.uid)) strays.add(row.id); else rows.put(row.uid, row);
   }
  }
  for (long id : strays) resolver.delete(VvmProvider.voicemail(context, id), null, null);
  return rows;
 }

 /**
  * Stores one message's audio in its row and then marks the row as having it. Audio over
  * {@link #MAX_AUDIO_BYTES}, in an encoding or type this client does not handle, is left on the server.
  */
 private static boolean download(Context context, ImapClient imap, Row row, Part part) throws IOException {
  boolean base64 = part.encoding.equals("base64");
  if (!base64 && !part.encoding.equals("binary") && !part.encoding.equals("8bit") && !part.encoding.equals("7bit")) return false;
  // Base64 with line breaks is at most 4/3 of the audio plus two bytes per 76; 3/2 covers it.
  long limit = base64 ? MAX_AUDIO_BYTES * 3L / 2 : MAX_AUDIO_BYTES;
  // 76 base64 characters and a line break carry 57 bytes, so this is the least the part can decode to.
  if (part.size <= 0 || part.size > limit || (base64 && part.size * 57 / 78 - 4 > MAX_AUDIO_BYTES)) return false;
  ContentResolver resolver = context.getContentResolver();
  Uri uri = VvmProvider.voicemail(context, row.id);
  boolean[] unusable = { false };
  boolean delivered = imap.fetchBody(row.uid, part.section, limit, body -> {
   InputStream audio = base64 ? Base64.getMimeDecoder().wrap(body) : body;
   long total = 0;
   try (OutputStream out = resolver.openOutputStream(uri, "wt")) {
    if (out == null) throw new IOException("Voicemail row not writable");
    byte[] buffer = new byte[16 * 1024];
    for (int n; !unusable[0] && (n = audio.read(buffer)) >= 0; ) {
     if ((total += n) > MAX_AUDIO_BYTES) unusable[0] = true; else out.write(buffer, 0, n);
    }
   } catch (IllegalArgumentException undecodable) { unusable[0] = true; }
   if (total == 0) unusable[0] = true;
  });
  if (!delivered) return false;
  if (unusable[0]) {
   // Too large after decoding, empty or not base64 after all: the row keeps no part of it and stays without audio.
   try (OutputStream out = resolver.openOutputStream(uri, "wt")) { if (out != null) out.flush(); }
   return false;
  }
  ContentValues values = new ContentValues();
  values.put(Voicemails.MIME_TYPE, part.mimeType);
  values.put(Voicemails.HAS_CONTENT, 1);
  values.put(Voicemails.DIRTY, Voicemails.DIRTY_RETAIN);
  resolver.update(uri, values, null, null);
  row.hasContent = true;
  return true;
 }

 // ---- Message interpretation (pure) ---------------------------------------------------------

 /** The first {@code audio/*} leaf of a BODYSTRUCTURE, with its body section number; null when there is none. */
 static Part audioPart(Object structure) { return audioPart(structure, "", 0); }
 private static Part audioPart(Object structure, String prefix, int depth) {
  if (!(structure instanceof List) || depth > MAX_DEPTH) return null;
  List<?> node = (List<?>) structure;
  if (node.isEmpty()) return null;
  if (node.get(0) instanceof List) {
   for (int i = 0; i < node.size() && node.get(i) instanceof List; i++) {
    Part part = audioPart(node.get(i), prefix.isEmpty() ? String.valueOf(i + 1) : prefix + "." + (i + 1), depth + 1);
    if (part != null) return part;
   }
   return null;
  }
  if (node.size() < 7 || !(node.get(0) instanceof String) || !(node.get(1) instanceof String)) return null;
  String type = (((String) node.get(0)) + "/" + node.get(1)).toLowerCase(Locale.ROOT);
  if (!AUDIO_TYPE.matcher(type).matches()) return null;
  String encoding = node.get(5) instanceof String ? ((String) node.get(5)).toLowerCase(Locale.ROOT) : "7bit";
  long size = node.get(6) instanceof String ? ImapClient.count((String) node.get(6)) : -1;
  return new Part(prefix.isEmpty() ? "1" : prefix, type, encoding, size);
 }

 /** The caller's number from an ENVELOPE's first From address ({@code number@domain}, or {@code VOICE=number}); "" when withheld or not a number. */
 static String sender(Object envelope) {
  if (!(envelope instanceof List) || ((List<?>) envelope).size() < 3 || !(((List<?>) envelope).get(2) instanceof List)) return "";
  List<?> from = (List<?>) ((List<?>) envelope).get(2);
  if (from.isEmpty() || !(from.get(0) instanceof List) || ((List<?>) from.get(0)).size() < 3 || !(((List<?>) from.get(0)).get(2) instanceof String)) return "";
  String mailbox = (String) ((List<?>) from.get(0)).get(2);
  if (mailbox.length() > 64) return "";
  if (mailbox.regionMatches(true, 0, "VOICE=", 0, 6)) mailbox = mailbox.substring(6);
  mailbox = mailbox.replaceAll("[ ().-]", "");
  return PHONE.matcher(mailbox).matches() ? mailbox : "";
 }

 /** When the message was left: the envelope's Date header, else the server's INTERNALDATE; -1 when neither reads. */
 static long date(ImapClient.Fetched message) {
  Object envelope = message.items.get("ENVELOPE");
  if (envelope instanceof List && !((List<?>) envelope).isEmpty() && ((List<?>) envelope).get(0) instanceof String) {
   String header = ((String) ((List<?>) envelope).get(0)).replaceAll("\\s*\\([^)]*\\)\\s*$", "").trim();
   for (String pattern : new String[] { "EEE, d MMM yyyy HH:mm:ss Z", "d MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm Z" }) {
    long parsed = parse(pattern, header);
    if (parsed > 0) return parsed;
   }
  }
  Object internal = message.items.get("INTERNALDATE");
  return internal instanceof String ? parse("d-MMM-yyyy HH:mm:ss Z", ((String) internal).trim()) : -1;
 }
 private static long parse(String pattern, String text) {
  if (text.length() > 64) return -1;
  SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
  format.setLenient(false);
  ParsePosition at = new ParsePosition(0);
  Date date = format.parse(text, at);
  return date == null || at.getIndex() != text.length() || date.getTime() <= 0 ? -1 : date.getTime();
 }

 /** The message length in seconds from its Content-Duration header; 0 when the server sent none. */
 static long duration(ImapClient.Fetched message) {
  for (Map.Entry<String, Object> item : message.items.entrySet()) {
   if (!item.getKey().startsWith("BODY[HEADER.FIELDS") || !(item.getValue() instanceof String)) continue;
   for (String line : ((String) item.getValue()).split("\r?\n")) {
    int colon = line.indexOf(':');
    if (colon < 0 || !line.substring(0, colon).trim().equalsIgnoreCase("Content-Duration")) continue;
    String value = line.substring(colon + 1).trim();
    if (value.matches("[0-9]{1,5}")) return Long.parseLong(value);
   }
  }
  return 0;
 }
}

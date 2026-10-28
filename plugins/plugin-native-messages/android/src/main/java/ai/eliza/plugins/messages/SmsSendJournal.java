package ai.eliza.plugins.messages;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Durable journal of reviewed native SMS sends for hosts admitted to the AOSP telephony profile. Plain
 * Java so the JVM tests exercise it without Android.
 *
 * The record shape follows the shared device-action contract `sms.send.v1` ({@code @elizaos/contracts/sms-send}):
 * the operation ID is the execution claim's idempotency key, the binding hash is
 * SHA-256 over the fixed JSON field order of {@link #bindingText}, and status is one of cancelled,
 * denied, failed, unknown, submitted, sent or delivered, with per-part sent and delivery evidence.
 *
 * Rules: a repeated operation ID only reads its record; nothing here ever resends. "submitted" means
 * the platform send call returned. "sent" requires a successful sent callback for every part,
 * "delivered" a delivery report for every part whose provider status reads complete. A record that was
 * being dispatched when the process died, or whose sent callbacks cannot arrive any more because the
 * phone restarted, becomes "unknown". The message body is never stored, only its SHA-256.
 *
 * Bounds: at most {@link #MAX_RECORDS} records. When full, the oldest closed records are dropped, then
 * the oldest records still waiting for evidence, so a carrier that never sends delivery reports cannot
 * block sending. A dropped record leaves a tombstone of its operation ID and binding (the newest
 * {@link #MAX_TOMBSTONES}); older tombstones are folded into a fixed-size filter of operation-ID
 * hashes. No operation ID is ever forgotten: a repeated ID that matches a record, a tombstone or the
 * filter is refused and never sent again. The filter has no false negatives; a false positive only
 * refuses one fresh ID (the caller starts a new review with a new ID), so storage stays bounded and
 * sending is never permanently locked out.
 */
public final class SmsSendJournal {
 public static final int MAX_RECIPIENTS = 5, MAX_BODY = 1600, MAX_PARTS_PER_RECIPIENT = 10, MAX_RECORDS = 200, MAX_TOMBSTONES = 1000;
 /**
  * Retired-ID filter: 2^20 bits (128 KiB), 8 probes from SHA-256 of the ID. At 20,000 retired IDs a
  * fresh ID is refused with probability about 1e-6; at 100,000 about 0.3%. Never a false negative.
  */
 static final int FILTER_BITS = 1 << 20, FILTER_PROBES = 8;
 /** After this, no more evidence is awaited for a record: delivery reports are not retried for longer. */
 public static final long MAX_OPEN_MS = 7L * 24 * 60 * 60 * 1000;
 /** A repeated operation ID whose record was dropped from the bounded journal. Nothing is sent for it. */
 public static final class Expired extends IllegalStateException { Expired() { super("operation expired"); } }
 public static final Pattern OPERATION = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
 public static final Pattern NUMBER = Pattern.compile("^\\+?[0-9]{2,20}$");
 static final char UNKNOWN = 'u', SUCCESS = 's', FAILED = 'f';
 /** Provider SMS status column values (android.provider.Telephony.TextBasedSmsColumns). */
 public static final int STATUS_NONE = -1, STATUS_COMPLETE = 0, STATUS_PENDING = 32, STATUS_FAILED = 64;
 /** Provider SMS type column values of outgoing rows (Telephony.TextBasedSmsColumns.MESSAGE_TYPE_*). */
 public static final int TYPE_SENT = 2, TYPE_OUTBOX = 4, TYPE_FAILED = 5;

 /** One reviewed send. Mutable fields are only changed under the journal's lock. */
 public static final class Record {
  public final String operationId, bindingHash;
  final String bodyHash;
  public final int subscriptionId;
  public final long createdAt;
  final long boot;
  final String[] recipients;
  /** Terminal decision before any dispatch: cancelled or denied. Null otherwise. */
  String decision;
  /** dispatching: persisted before the first platform call; submitted: every call returned. */
  boolean dispatching, submitted, unknown;
  int[] partsPerRecipient;
  char[] sent, delivery;
  boolean[] reported;
  long[] providerRow;
  Record(String operationId, int subscriptionId, String bindingHash, String bodyHash, String[] recipients, long createdAt, long boot) {
   this.operationId = operationId; this.subscriptionId = subscriptionId; this.bindingHash = bindingHash; this.bodyHash = bodyHash;
   this.recipients = recipients; this.createdAt = createdAt; this.boot = boot;
   partsPerRecipient = new int[0]; sent = new char[0]; delivery = new char[0]; reported = new boolean[0]; providerRow = new long[recipients.length];
  }
  int parts() { return sent.length; }
  int recipientOf(int index) { int seen = 0; for (int r = 0; r < partsPerRecipient.length; r++) { seen += partsPerRecipient[r]; if (index < seen) return r; } throw new IndexOutOfBoundsException(); }
  int partOf(int index) { int seen = 0; for (int r = 0; r < partsPerRecipient.length; r++) { if (index < seen + partsPerRecipient[r]) return index - seen; seen += partsPerRecipient[r]; } throw new IndexOutOfBoundsException(); }
  int firstPart(int recipient) { int seen = 0; for (int r = 0; r < recipient; r++) seen += partsPerRecipient[r]; return seen; }
  /** The contract status, derived only from recorded evidence. */
  public String status() {
   if (decision != null) return decision;
   boolean anyFailed = false, allSent = parts() > 0, allDelivered = parts() > 0;
   for (int i = 0; i < parts(); i++) {
    if (sent[i] == FAILED) anyFailed = true;
    if (sent[i] != SUCCESS) allSent = false;
    if (delivery[i] != SUCCESS) allDelivered = false;
   }
   if (anyFailed) return "failed";
   if (allSent && partsPerRecipient.length == recipients.length) return allDelivered ? "delivered" : "sent";
   if (unknown || dispatching) return "unknown";
   return submitted ? "submitted" : "unknown";
  }
  /**
   * Further evidence can still change this record. Callbacks cannot arrive after a restart, so a part
   * waits across one only when its delivery report already arrived and the provider status is unread.
   */
  boolean open(long currentBoot, long now) {
   if (decision != null || now - createdAt > MAX_OPEN_MS) return false;
   boolean sameBoot = boot == currentBoot;
   for (int i = 0; i < parts(); i++) {
    if (sent[i] == UNKNOWN && sameBoot) return true;
    if (sent[i] == SUCCESS && delivery[i] == UNKNOWN && (sameBoot || reported[i])) return true;
   }
   return false;
  }
 }

 public interface Storage { String read() throws IOException; void write(String value) throws IOException; }
 /**
  * Salt of the retired-ID filter. Migration-sensitive: a host that already has compacted IDs must keep
  * the namespace it wrote them with, or those IDs would stop being refused.
  */
 public static final String DEFAULT_RETIRED_NAMESPACE = "eliza-sms-operation:v1:";
 private final Storage storage;
 private final String retiredNamespace;
 private final Map<String, Record> records = new LinkedHashMap<>();
 /** Operation ID to binding hash of records dropped by the bound, oldest first. */
 private final Map<String, String> tombstones = new LinkedHashMap<>();
 /** Bloom filter of operation IDs whose tombstones were compacted. Allocated on first compaction. */
 private byte[] retired;
 private long retiredCount;
 /**
  * Latest creation time of any record dropped by the bound (Long.MIN_VALUE when none). Pruned records
  * keep no address metadata, so provider-row attribution near or after this time is ambiguous.
  */
 private long prunedThrough = Long.MIN_VALUE;
 public SmsSendJournal(Storage storage) throws IOException { this(storage, DEFAULT_RETIRED_NAMESPACE); }
 public SmsSendJournal(Storage storage, String retiredNamespace) throws IOException {
  if (retiredNamespace == null || !retiredNamespace.matches("[a-z0-9][a-z0-9._:-]{0,63}")) throw new IllegalArgumentException("Invalid retired-ID namespace");
  this.storage = storage; this.retiredNamespace = retiredNamespace; load();
 }
 /** File adapter is used only by the JVM tests; Android supplies encrypted credential storage. */
 SmsSendJournal(File file) throws IOException { this(fileStorage(file)); }
 private static Storage fileStorage(File file) { return new Storage() {
  public String read() throws IOException { return file.exists() ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) : null; }
  public void write(String value) throws IOException {
   File temp = new File(file.getPath() + ".tmp");
   try (FileOutputStream stream = new FileOutputStream(temp)) { stream.write(value.getBytes(StandardCharsets.UTF_8)); stream.getFD().sync(); }
   Files.move(temp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
  }
 }; }

 // ---- Validation and binding ------------------------------------------------------------------

 /** Throws IllegalArgumentException unless the request matches `validateSmsSend` in the shared contract. */
 public static void validate(String operationId, String[] recipients, String body, int subscriptionId) {
  if (operationId == null || !OPERATION.matcher(operationId).matches()) throw new IllegalArgumentException("operation");
  if (recipients == null || recipients.length < 1 || recipients.length > MAX_RECIPIENTS) throw new IllegalArgumentException("recipients");
  for (int i = 0; i < recipients.length; i++) {
   if (recipients[i] == null || !NUMBER.matcher(recipients[i]).matches()) throw new IllegalArgumentException("recipient");
   for (int j = 0; j < i; j++) if (recipients[j].equals(recipients[i])) throw new IllegalArgumentException("duplicate recipient");
  }
  if (body == null || body.isEmpty() || body.length() > MAX_BODY || body.indexOf('\0') >= 0) throw new IllegalArgumentException("body");
  for (int i = 0; i < body.length(); i++) {
   char c = body.charAt(i);
   if (Character.isHighSurrogate(c)) { if (i + 1 >= body.length() || !Character.isLowSurrogate(body.charAt(i + 1))) throw new IllegalArgumentException("body"); i++; }
   else if (Character.isLowSurrogate(c)) throw new IllegalArgumentException("body");
  }
  if (subscriptionId < 0) throw new IllegalArgumentException("subscription");
 }

 /** Byte-for-byte `JSON.stringify({body, recipients, subscriptionId, type})` of the shared contract. */
 public static String bindingText(String[] recipients, String body, int subscriptionId) {
  StringBuilder out = new StringBuilder("{\"body\":");
  json(out, body);
  out.append(",\"recipients\":[");
  for (int i = 0; i < recipients.length; i++) { if (i > 0) out.append(','); json(out, recipients[i]); }
  return out.append("],\"subscriptionId\":").append(subscriptionId).append(",\"type\":\"sms_send\"}").toString();
 }
 private static void json(StringBuilder out, String value) {
  out.append('"');
  for (int i = 0; i < value.length(); i++) {
   char c = value.charAt(i);
   switch (c) {
    case '"': out.append("\\\""); break;
    case '\\': out.append("\\\\"); break;
    case '\b': out.append("\\b"); break;
    case '\f': out.append("\\f"); break;
    case '\n': out.append("\\n"); break;
    case '\r': out.append("\\r"); break;
    case '\t': out.append("\\t"); break;
    default: if (c < 0x20) out.append(String.format("\\u%04x", (int) c)); else out.append(c);
   }
  }
  out.append('"');
 }
 public static String sha256(String text) {
  try {
   byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
   StringBuilder hex = new StringBuilder(64);
   for (byte b : digest) hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
   return hex.toString();
  } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
 }

 // ---- Lifecycle of one send -------------------------------------------------------------------

 public synchronized Record get(String operationId) { return records.get(operationId); }

 /** The existing record for a repeated ID, or null for a new one. A reused ID with different content is refused. */
 public synchronized Record existing(String operationId, String bindingHash) {
  Record found = records.get(operationId);
  String dropped = found == null ? tombstones.get(operationId) : null;
  if (dropped != null) { if (!dropped.equals(bindingHash)) throw new IllegalStateException("operation reused"); throw new Expired(); }
  // A compacted ID keeps no binding: it can never be sent again, whatever the content.
  if (found == null && isRetired(operationId)) throw new Expired();
  if (found != null && !found.bindingHash.equals(bindingHash)) throw new IllegalStateException("operation reused");
  return found;
 }

 /** Records an outcome reached without any platform call: the owner cancelled or Android refused it. */
 synchronized Record decide(String operationId, String[] recipients, String body, int subscriptionId, String decision, long now, long boot) throws IOException {
  if (!"cancelled".equals(decision) && !"denied".equals(decision)) throw new IllegalArgumentException("decision");
  Record record = create(operationId, recipients, body, subscriptionId, now, boot);
  record.decision = decision;
  persistNew(record);
  return record;
 }

 /** Persists the reviewed send before the first platform call, so an interrupted dispatch reads "unknown" and is never repeated. */
 synchronized Record beginDispatch(String operationId, String[] recipients, String body, int subscriptionId, int[] partsPerRecipient, long now, long boot) throws IOException {
  if (partsPerRecipient.length != recipients.length) throw new IllegalArgumentException("parts");
  int total = 0;
  for (int count : partsPerRecipient) { if (count < 1 || count > MAX_PARTS_PER_RECIPIENT) throw new IllegalArgumentException("parts"); total += count; }
  Record record = create(operationId, recipients, body, subscriptionId, now, boot);
  record.partsPerRecipient = partsPerRecipient.clone();
  record.sent = new char[total]; record.delivery = new char[total]; record.reported = new boolean[total];
  java.util.Arrays.fill(record.sent, UNKNOWN); java.util.Arrays.fill(record.delivery, UNKNOWN);
  record.dispatching = true;
  persistNew(record);
  return record;
 }
 /** A new record that cannot be made durable is forgotten, so it never reads as a send that may have happened. */
 private void persistNew(Record record) throws IOException {
  try { save(); } catch (IOException | RuntimeException failed) { records.remove(record.operationId); throw failed; }
 }
 private Record create(String operationId, String[] recipients, String body, int subscriptionId, long now, long boot) {
  validate(operationId, recipients, body, subscriptionId);
  if (records.containsKey(operationId) || tombstones.containsKey(operationId) || isRetired(operationId)) throw new IllegalStateException("operation exists");
  prune(boot, now);
  Record record = new Record(operationId, subscriptionId, sha256(bindingText(recipients, body, subscriptionId)), sha256(body), recipients.clone(), now, boot);
  records.put(operationId, record);
  return record;
 }

 /** Every platform send call returned (submitted), or one threw (the outcome cannot be known). */
 synchronized void endDispatch(String operationId, boolean allReturned) throws IOException {
  Record record = records.get(operationId);
  if (record == null || !record.dispatching) return;
  record.dispatching = false;
  if (allReturned) record.submitted = true; else record.unknown = true;
  save();
 }

 /** A sent PendingIntent result. Only Activity.RESULT_OK (-1) is success. The first answer per part stands. */
 synchronized boolean sentResult(String operationId, int index, boolean ok) throws IOException {
  Record record = records.get(operationId);
  if (record == null || record.decision != null || index < 0 || index >= record.parts() || record.sent[index] != UNKNOWN) return false;
  record.sent[index] = ok ? SUCCESS : FAILED;
  save();
  return true;
 }

 /** A delivery PendingIntent arrived for this part. Its outcome is resolved from the provider status. */
 synchronized boolean deliveryReported(String operationId, int index) throws IOException {
  Record record = records.get(operationId);
  if (record == null || record.decision != null || index < 0 || index >= record.parts() || record.reported[index]) return false;
  record.reported[index] = true;
  save();
  return true;
 }

 /** The provider row the platform wrote for this recipient's message (matched by address, time and body hash). */
 synchronized void providerRow(String operationId, int recipient, long row) throws IOException {
  Record record = records.get(operationId);
  if (record == null || recipient < 0 || recipient >= record.recipients.length || row <= 0 || record.providerRow[recipient] != 0) return;
  record.providerRow[recipient] = row;
  save();
 }

 /**
  * The provider row recorded for the recipient of this part and the type its message now has:
  * {@link #TYPE_FAILED} once any of that recipient's parts failed, {@link #TYPE_SENT} once all of them
  * were sent, null while a part is still waiting or no row is recorded. Only the default SMS app,
  * which writes its own rows because Android writes none for it, moves a row with this, and only out
  * of the outbox.
  */
 synchronized long[] settledRow(String operationId, int index) {
  Record record = records.get(operationId);
  if (record == null || record.decision != null || index < 0 || index >= record.parts()) return null;
  int recipient = record.recipientOf(index);
  long row = record.providerRow[recipient];
  if (row <= 0) return null;
  boolean waiting = false;
  int first = record.firstPart(recipient);
  for (int i = first; i < first + record.partsPerRecipient[recipient]; i++) {
   if (record.sent[i] == FAILED) return new long[] { row, TYPE_FAILED };
   if (record.sent[i] == UNKNOWN) waiting = true;
  }
  return waiting ? null : new long[] { row, TYPE_SENT };
 }

 /**
  * Applies the provider's delivery status to the part of one recipient whose delivery report has
  * arrived and whose sent callback succeeded. Pending or absent status changes nothing.
  *
  * Only single-part messages: the platform keeps one provider row per multipart message and each
  * part's status report overwrites its status, so the row cannot say which part was delivered or
  * failed. Multipart delivery therefore stays unknown rather than being inferred from the last report.
  */
 synchronized boolean providerStatus(String operationId, int recipient, int status) throws IOException {
  Record record = records.get(operationId);
  if (record == null || recipient < 0 || recipient >= record.partsPerRecipient.length || record.partsPerRecipient[recipient] != 1) return false;
  char outcome = status == STATUS_COMPLETE ? SUCCESS : status >= STATUS_FAILED ? FAILED : UNKNOWN;
  if (outcome == UNKNOWN) return false;
  boolean changed = false;
  int first = record.firstPart(recipient);
  for (int i = first; i < first + record.partsPerRecipient[recipient]; i++)
   if (record.reported[i] && record.sent[i] == SUCCESS && record.delivery[i] == UNKNOWN) { record.delivery[i] = outcome; changed = true; }
  if (changed) save();
  return changed;
 }

 /**
  * Startup and observer reconciliation. A dispatch interrupted by process death and a send whose
  * callbacks can no longer arrive (the phone restarted since) become "unknown". Never resends.
  */
 synchronized boolean reconcile(long boot, boolean dispatchingInThisProcess) throws IOException {
  boolean changed = false;
  for (Record record : records.values()) {
   if (record.dispatching && !dispatchingInThisProcess) { record.dispatching = false; record.unknown = true; changed = true; }
   if (record.decision == null && !record.unknown && record.boot != boot) {
    for (int i = 0; i < record.parts(); i++) if (record.sent[i] == UNKNOWN) { record.unknown = true; changed = true; break; }
   }
  }
  if (changed) save();
  return changed;
 }

 synchronized List<Record> open(long boot, long now) {
  List<Record> found = new ArrayList<>();
  for (Record record : records.values()) if (record.open(boot, now)) found.add(record);
  return found;
 }

 /** The newest records first, at most limit. */
 public synchronized List<Record> recent(int limit) {
  List<Record> all = new ArrayList<>(records.values());
  java.util.Collections.reverse(all);
  return all.subList(0, Math.min(limit, all.size()));
 }

 /**
  * Makes room for one record: drops the oldest closed records, then the oldest still awaiting evidence
  * (never one being dispatched), each leaving a tombstone so its operation ID is never sent again.
  */
 private void prune(long boot, long now) {
  for (int pass = 0; pass < 2 && records.size() >= MAX_RECORDS; pass++) {
   java.util.Iterator<Record> each = records.values().iterator();
   while (records.size() >= MAX_RECORDS && each.hasNext()) {
    Record record = each.next();
    if (record.dispatching || (pass == 0 && record.open(boot, now))) continue;
    each.remove();
    tombstones.remove(record.operationId);
    tombstones.put(record.operationId, record.bindingHash);
    // Only dispatched records can own provider rows; cancelled or denied ones never reached Android.
    if (record.decision == null) prunedThrough = Math.max(prunedThrough, record.createdAt);
   }
  }
  // Older tombstones are compacted, never discarded: their IDs stay refused through the filter.
  java.util.Iterator<String> oldest = tombstones.keySet().iterator();
  while (tombstones.size() > MAX_TOMBSTONES && oldest.hasNext()) { retire(oldest.next()); oldest.remove(); }
  if (records.size() >= MAX_RECORDS) throw new IllegalStateException("journal full");
 }

 private int[] probes(String operationId) {
  byte[] digest;
  try { digest = MessageDigest.getInstance("SHA-256").digest((retiredNamespace + operationId).getBytes(StandardCharsets.UTF_8)); }
  catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
  int[] bits = new int[FILTER_PROBES];
  for (int k = 0; k < FILTER_PROBES; k++) bits[k] = (((digest[3 * k] & 0xff) << 16) | ((digest[3 * k + 1] & 0xff) << 8) | (digest[3 * k + 2] & 0xff)) & (FILTER_BITS - 1);
  return bits;
 }
 private void retire(String operationId) {
  if (retired == null) retired = new byte[FILTER_BITS / 8];
  for (int bit : probes(operationId)) retired[bit >>> 3] |= (byte) (1 << (bit & 7));
  retiredCount++;
 }
 /** True when the ID was compacted (or, rarely, collides with compacted IDs). Either way it is refused. */
 synchronized boolean isRetired(String operationId) {
  if (retired == null) return false;
  for (int bit : probes(operationId)) if ((retired[bit >>> 3] & (1 << (bit & 7))) == 0) return false;
  return true;
 }
 synchronized long retiredCount() { return retiredCount; }

 /** Matching by content is unsafe when another operation could own the provider row. */
 synchronized boolean ambiguousProviderOwner(Record record, int recipient, long window) {
  for (Record other : records.values()) {
   if (other == record || other.decision != null || other.subscriptionId != record.subscriptionId || !other.bodyHash.equals(record.bodyHash) || Math.abs(other.createdAt - record.createdAt) > window) continue;
   for (String address : other.recipients) if (address.equals(record.recipients[recipient])) return true;
  }
  // Pruned operations keep no address metadata, so they cannot be excluded for a record created within
  // the window of (or before) the latest pruned record. Later records attribute normally. Sending is
  // never blocked by this; ambiguous delivery stays unknown.
  return prunedThrough != Long.MIN_VALUE && record.createdAt - window <= prunedThrough;
 }
 /** At most one matching provider row, with complete enumeration and no previous owner. */
 static final class ProviderMatch {
  private long row; private int seen; private boolean ambiguous;
  boolean visit(long id, boolean matches, boolean claimed) {
   if (++seen > 20) { ambiguous = true; return false; }
   if (matches) { if (row != 0 || claimed) ambiguous = true; row = id; }
   return true;
  }
  long result() { return ambiguous ? 0 : row; }
 }

 // ---- Storage: one line per record, atomically replaced ---------------------------------------

 static String encode(Record r) {
  StringBuilder line = new StringBuilder("v1|").append(r.operationId).append('|').append(r.subscriptionId).append('|').append(r.bindingHash).append('|').append(r.bodyHash)
   .append('|').append(r.createdAt).append('|').append(r.boot).append('|').append(String.join(",", r.recipients)).append('|').append(r.decision == null ? "-" : r.decision)
   .append('|').append(r.dispatching ? 1 : 0).append(r.submitted ? 1 : 0).append(r.unknown ? 1 : 0).append('|');
  for (int i = 0; i < r.partsPerRecipient.length; i++) { if (i > 0) line.append(','); line.append(r.partsPerRecipient[i]); }
  line.append('|').append(r.sent.length == 0 ? "-" : new String(r.sent)).append('|').append(r.delivery.length == 0 ? "-" : new String(r.delivery)).append('|');
  if (r.reported.length == 0) line.append('-'); else for (boolean seen : r.reported) line.append(seen ? '1' : '0');
  line.append('|');
  for (int i = 0; i < r.providerRow.length; i++) { if (i > 0) line.append(','); line.append(r.providerRow[i]); }
  return line.toString();
 }
 static Record decode(String line) {
  String[] f = line.split("\\|", -1);
  if (f.length != 15 || !"v1".equals(f[0])) throw new IllegalArgumentException("record");
  String[] recipients = f[7].split(",", -1);
  Record r = new Record(f[1], Integer.parseInt(f[2]), f[3], f[4], recipients, Long.parseLong(f[5]), Long.parseLong(f[6]));
  if (!OPERATION.matcher(r.operationId).matches() || !r.bindingHash.matches("[0-9a-f]{64}") || !r.bodyHash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("record");
  for (String number : recipients) if (!NUMBER.matcher(number).matches()) throw new IllegalArgumentException("record");
  r.decision = "-".equals(f[8]) ? null : f[8];
  if (r.decision != null && !"cancelled".equals(r.decision) && !"denied".equals(r.decision)) throw new IllegalArgumentException("record");
  if (f[9].length() != 3) throw new IllegalArgumentException("record");
  r.dispatching = f[9].charAt(0) == '1'; r.submitted = f[9].charAt(1) == '1'; r.unknown = f[9].charAt(2) == '1';
  if (!f[10].isEmpty()) { String[] counts = f[10].split(","); r.partsPerRecipient = new int[counts.length]; for (int i = 0; i < counts.length; i++) r.partsPerRecipient[i] = Integer.parseInt(counts[i]); }
  r.sent = "-".equals(f[11]) ? new char[0] : f[11].toCharArray();
  r.delivery = "-".equals(f[12]) ? new char[0] : f[12].toCharArray();
  r.reported = new boolean[r.sent.length];
  if (!"-".equals(f[13])) { if (f[13].length() != r.sent.length) throw new IllegalArgumentException("record"); for (int i = 0; i < r.reported.length; i++) r.reported[i] = f[13].charAt(i) == '1'; }
  int total = 0; for (int count : r.partsPerRecipient) total += count;
  if (total != r.sent.length || r.delivery.length != r.sent.length || (r.partsPerRecipient.length != 0 && r.partsPerRecipient.length != recipients.length)) throw new IllegalArgumentException("record");
  for (int i = 0; i < r.sent.length; i++) if ("usf".indexOf(r.sent[i]) < 0 || "usf".indexOf(r.delivery[i]) < 0) throw new IllegalArgumentException("record");
  String[] rows = f[14].split(",", -1);
  if (rows.length != recipients.length) throw new IllegalArgumentException("record");
  for (int i = 0; i < rows.length; i++) r.providerRow[i] = Long.parseLong(rows[i]);
  return r;
 }
 private void load() throws IOException {
  String saved = storage.read();
  if (saved == null) return;
  boolean watermark = false;
  // A damaged journal is an error, never an empty one: an empty journal would allow a resend.
  for (String line : saved.split("\n")) {
   if (line.isEmpty()) continue;
   if (line.startsWith("w1|")) {
    String[] f = line.split("\\|", -1);
    if (f.length != 2 || watermark) throw new IllegalArgumentException("record");
    prunedThrough = Long.parseLong(f[1]); watermark = true;
    continue;
   }
   if (line.startsWith("r1|")) {
    String[] f = line.split("\\|", -1);
    if (f.length != 3 || retired != null) throw new IllegalArgumentException("record");
    byte[] filter = java.util.Base64.getDecoder().decode(f[2]);
    long count = Long.parseLong(f[1]);
    if (filter.length != FILTER_BITS / 8 || count < 1) throw new IllegalArgumentException("record");
    retired = filter; retiredCount = count;
    continue;
   }
   if (line.startsWith("t1|")) {
    String[] f = line.split("\\|", -1);
    if (f.length != 3 || !OPERATION.matcher(f[1]).matches() || !f[2].matches("[0-9a-f]{64}")) throw new IllegalArgumentException("record");
    tombstones.put(f[1], f[2]);
    continue;
   }
   Record record = decode(line);
   records.put(record.operationId, record);
  }
  // A journal written before the watermark existed has pruned records of unknown time: attribution
  // stays off for it rather than guessing.
  if (!watermark && (!tombstones.isEmpty() || retired != null)) prunedThrough = Long.MAX_VALUE;
 }
 private void save() throws IOException {
  StringBuilder out = new StringBuilder();
  if (prunedThrough != Long.MIN_VALUE) out.append("w1|").append(prunedThrough).append('\n');
  if (retired != null) out.append("r1|").append(retiredCount).append('|').append(java.util.Base64.getEncoder().encodeToString(retired)).append('\n');
  for (Map.Entry<String, String> dropped : tombstones.entrySet()) out.append("t1|").append(dropped.getKey()).append('|').append(dropped.getValue()).append('\n');
  for (Record record : records.values()) out.append(encode(record)).append('\n');
  storage.write(out.toString());
 }
}

package ai.eliza.plugins.actionjournal;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Objects;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable execution journal for host-approved device actions. Each entry moves
 * reserved -> applying -> terminal exactly once; no entry is permission to execute twice.
 *
 * <p>The journal stores one index slot and one entry slot per proposal in a host-supplied
 * durable store. The index commits before the entry, so a crash can leave a harmless listed
 * id without an entry, never an unlisted effect. Hosts supply result validation and the
 * passive list view through {@link ResultPolicy}; this class performs no action itself.
 */
public final class ActionJournal {
 /** Durable, encrypted string store owned by the host. Writes must throw on failure. */
 public interface Storage {
  String read(String slot) throws Exception;
  void write(String slot, String value) throws Exception;
 }

 /** Host-specific result admission and passive list redaction. */
 public interface ResultPolicy {
  /** Throw to refuse a terminal transition. {@code result} may be null. */
  void check(JSONObject entry, String status, JSONObject result) throws Exception;
  /** Returns the copy a passive list exposes. Must not mutate {@code entry}. */
  default JSONObject listView(JSONObject entry) throws Exception { return entry; }
 }

 /** A host transition on one existing entry, run under the journal lock. */
 public interface Transition { JSONObject apply(JSONObject entry) throws Exception; }

 /** Result of {@link #reserve}: the stored entry and whether this call created it. */
 public static final class Reservation {
  public final JSONObject entry;
  public final boolean created;
  Reservation(JSONObject entry, boolean created) { this.entry = entry; this.created = created; }
 }

 /** Refused transition: the stored journal is unchanged. */
 public static final class Refused extends IllegalStateException {
  public Refused(String message) { super(message); }
 }

 public static final Set<String> STATUSES = java.util.Collections.unmodifiableSet(new java.util.HashSet<>(java.util.Arrays.asList("succeeded", "failed", "unknown", "cancelled")));
 /** Default policy: any result is a small, opaque summary without retained private reads. */
 public static final ResultPolicy BOUNDED_RESULTS = (entry, status, result) -> {
  if (result != null && (utf8(result) > 8000 || result.has("readResult"))) throw new IllegalArgumentException("Result too large");
 };

 private static final String SCOPE = "[a-f0-9]{64}", ID = "[A-Za-z0-9_-]{1,128}";
 private final Object lock = new Object();
 private final ActionJournalConfiguration configuration;
 private final Storage storage;
 private final ResultPolicy policy;
 private final Clock clock;

 /** Milliseconds since the epoch; replaceable only for deterministic tests. */
 public interface Clock { long now(); }

 public ActionJournal(ActionJournalConfiguration configuration, Storage storage, ResultPolicy policy) {
  this(configuration, storage, policy, System::currentTimeMillis);
 }

 public ActionJournal(ActionJournalConfiguration configuration, Storage storage, ResultPolicy policy, Clock clock) {
  this.configuration = Objects.requireNonNull(configuration);
  this.storage = Objects.requireNonNull(storage);
  this.policy = Objects.requireNonNull(policy);
  this.clock = Objects.requireNonNull(clock);
 }

 /** The monitor that serializes every journal read-modify-write. Hosts may hold it for a compound transition. */
 public Object lock() { return lock; }

 public static String field(String value, String pattern) {
  if (value == null || !value.matches(pattern)) throw new IllegalArgumentException("Invalid journal field");
  return value;
 }
 public static String scope(String value) { return field(value, SCOPE); }
 public static String id(String value) { return field(value, ID); }
 public static int utf8(Object value) { return String.valueOf(value).getBytes(StandardCharsets.UTF_8).length; }

 /** Structural JSON equality, independent of key order. */
 public static boolean sameJson(Object a, Object b) throws Exception {
  if (a instanceof JSONObject && b instanceof JSONObject) {
   JSONObject left = (JSONObject) a, right = (JSONObject) b;
   if (left.length() != right.length()) return false;
   Iterator<String> keys = left.keys();
   while (keys.hasNext()) { String name = keys.next(); if (!right.has(name) || !sameJson(left.get(name), right.get(name))) return false; }
   return true;
  }
  if (a instanceof JSONArray && b instanceof JSONArray) {
   JSONArray left = (JSONArray) a, right = (JSONArray) b;
   if (left.length() != right.length()) return false;
   for (int i = 0; i < left.length(); i++) if (!sameJson(left.get(i), right.get(i))) return false;
   return true;
  }
  if (a == null || a == JSONObject.NULL) return b == null || b == JSONObject.NULL;
  // Parsed and in-memory JSON may hold the same number as Integer, Long or Double.
  if (a instanceof Number && b instanceof Number) {
   try { return new java.math.BigDecimal(a.toString()).compareTo(new java.math.BigDecimal(b.toString())) == 0; }
   catch (NumberFormatException notFinite) { return a.toString().equals(b.toString()); }
  }
  return Objects.equals(a, b);
 }

 public String entrySlot(String scope, String id) { return configuration.namespace + ":" + scope(scope) + ":entry:" + id(id); }
 public String indexSlot(String scope) { return configuration.namespace + ":" + scope(scope) + ":index"; }

 private JSONObject readEntry(String scope, String id) throws Exception {
  String value = storage.read(entrySlot(scope, id));
  return value == null ? null : new JSONObject(value);
 }
 private void writeEntry(String scope, String id, JSONObject entry) throws Exception { storage.write(entrySlot(scope, id), entry.toString()); }

 /** Reserves one proposal. An identical replay returns the stored entry; a changed one is refused. */
 public Reservation reserve(String scope, String id, String operationId, String operationHash, JSONObject record) throws Exception {
  scope(scope); id(id); field(operationId, ID); field(operationHash, "[a-f0-9]{64}");
  if (record == null || record.toString().length() > configuration.maxRecordChars) throw new IllegalArgumentException("Invalid journal record");
  synchronized (lock) {
   JSONObject entry = readEntry(scope, id);
   if (entry != null) {
    if (!operationId.equals(entry.getString("operationId")) || !operationHash.equals(entry.getString("operationHash")) || !sameJson(record, entry.getJSONObject("record"))) throw new Refused("Proposal is already journaled with a different operation");
    return new Reservation(entry, false);
   }
   String saved = storage.read(indexSlot(scope));
   JSONArray index = saved == null ? new JSONArray() : new JSONArray(saved);
   boolean listed = false;
   for (int i = 0; i < index.length(); i++) if (id.equals(index.getString(i))) listed = true;
   if (!listed) {
    if (index.length() >= configuration.maxEntries) throw new Refused("Action journal is full");
    index.put(id);
    storage.write(indexSlot(scope), index.toString());
   }
   // Index commits first: a crash can leave a harmless absent entry, never an unlisted effect.
   entry = new JSONObject().put("scope", scope).put("proposalId", id).put("operationId", operationId).put("operationHash", operationHash)
    .put("record", record).put("phase", "reserved").put("createdAt", clock.now());
   writeEntry(scope, id, entry);
   return new Reservation(entry, true);
  }
 }

 /** Records the dispatch intent of one attempt. Only a reserved entry may start applying. */
 public JSONObject markApplying(String scope, String id, String attemptId) throws Exception {
  field(attemptId, ID);
  synchronized (lock) {
   JSONObject entry = readEntry(scope(scope), id(id));
   if (entry == null || !"reserved".equals(entry.getString("phase"))) throw new Refused("Entry is not reserved");
   entry.put("attemptId", attemptId).put("phase", "applying").put("applyingAt", clock.now());
   writeEntry(scope, id, entry);
   return entry;
  }
 }

 /**
  * Moves an entry to its single terminal state. An identical replay of the terminal state is
  * returned unchanged; a different one is refused. Success requires a recorded dispatch.
  */
 public JSONObject finish(String scope, String id, String status, String summary, JSONObject result) throws Exception {
  if (!STATUSES.contains(status) || summary == null || summary.length() > configuration.maxSummaryChars) throw new IllegalArgumentException("Invalid terminal status");
  synchronized (lock) {
   JSONObject entry = readEntry(scope(scope), id(id));
   if (entry == null) throw new Refused("Entry is not journaled");
   policy.check(entry, status, result);
   if ("terminal".equals(entry.getString("phase"))) {
    if (!status.equals(entry.getString("status")) || !summary.equals(entry.getString("summary")) || !sameJson(result, entry.optJSONObject("result"))) throw new Refused("Entry already finished differently");
    return entry;
   }
   if ("succeeded".equals(status) && !"applying".equals(entry.getString("phase"))) throw new Refused("Success requires a recorded dispatch");
   entry.put("phase", "terminal").put("status", status).put("summary", summary).put("finishedAt", clock.now());
   if (result != null) entry.put("result", result);
   writeEntry(scope, id, entry);
   return entry;
  }
 }

 /**
  * Runs a host transition on an existing entry under the journal lock. The transition returns
  * the entry to store, or the same instance unchanged to skip the write. Identity fields
  * (scope, proposal, operation id and hash, record) can never change.
  */
 public JSONObject update(String scope, String id, Transition transition) throws Exception {
  synchronized (lock) {
   JSONObject entry = readEntry(scope(scope), id(id));
   JSONObject before = entry == null ? null : new JSONObject(entry.toString());
   JSONObject next = transition.apply(entry);
   if (next == null || next == entry && (before == null || sameJson(before, next))) return next;
   if (before == null) throw new Refused("Entry is not journaled");
   for (String name : new String[]{"scope", "proposalId", "operationId", "operationHash", "record", "createdAt", "attemptId", "applyingAt"})
    if (!sameJson(before.opt(name), next.opt(name))) throw new Refused("Journal identity cannot change");
   String phase = before.getString("phase"), nextPhase = next.getString("phase");
   if (!phase.equals(nextPhase) && !("applying".equals(phase) && "terminal".equals(nextPhase)))
    throw new Refused("Recovery cannot authorize another dispatch");
   if ("terminal".equals(phase) && !"unknown".equals(before.getString("status")) && !sameJson(before, next))
    throw new Refused("Settled journal entry cannot change");
   if ("terminal".equals(nextPhase)) {
    String status = next.getString("status"), summary = next.getString("summary");
    if (!STATUSES.contains(status) || summary.length() > configuration.maxSummaryChars) throw new Refused("Invalid recovery result");
    if ("succeeded".equals(status) && !before.has("attemptId")) throw new Refused("Success requires a recorded dispatch");
    policy.check(next, status, next.optJSONObject("result"));
   }
   writeEntry(scope, id, next);
   return next;
  }
 }

 /** One exact entry, including retained private results. */
 public JSONObject get(String scope, String id) throws Exception {
  synchronized (lock) { return readEntry(scope(scope), id(id)); }
 }

 /** Every listed entry in reservation order, through the host's passive list view. */
 public JSONArray list(String scope) throws Exception {
  synchronized (lock) {
   String saved = storage.read(indexSlot(scope(scope)));
   JSONArray index = saved == null ? new JSONArray() : new JSONArray(saved), entries = new JSONArray();
   for (int i = 0; i < index.length(); i++) {
    JSONObject entry = readEntry(scope, index.getString(i));
    if (entry != null) entries.put(policy.listView(entry));
   }
   return entries;
  }
 }
}

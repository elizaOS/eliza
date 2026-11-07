package ai.eliza.plugins.actionjournal.deletion;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Objects;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Single-process durable admission for delayed provider deletions (the reviewed Undo window).
 * Rows move queued -> (undone | paused | dispatching -> deleted | conflict | unknown) and a
 * dispatching write is never retried: after process death it reads back as {@code unknown}.
 *
 * <p>{@link Store#save} must commit atomically or throw; callers share one journal instance per
 * slot so its monitor serializes Undo against expiry. No Android types: host-tested by javac.
 */
public final class DeferredDeletionJournal {
 public interface Store { String read() throws Exception; void save(String value) throws Exception; }
 /** Returns a refusal reason (the row pauses) or null to admit the provider write. */
 public interface Admission { String refusal(JSONObject owner, JSONObject target) throws Exception; }
 /** Applies the provider write. Returns {@code {status: deleted|conflict|permission-required|unknown}}. */
 public interface Delete { JSONObject apply(JSONObject target) throws Exception; }

 /** Terminal receipts kept after a new stage retires older ones. */
 public static final int RETAINED_TERMINAL = 127;
 /** Rows at which staging refuses until uncertain history is reviewed. */
 public static final int MAX_ROWS = 500;
 /** Bytes kept free within a 4 MiB native slot for dispatch and outcome metadata. */
 public static final int MAX_STAGED_BYTES = 3 * 1024 * 1024;
 private static final int MAX_ACKNOWLEDGEMENTS = 1000;
 private static final Set<String> OUTCOMES = new HashSet<>(Arrays.asList("deleted", "conflict", "permission-required", "unknown"));

 private final Store store;

 public DeferredDeletionJournal(Store store) { this.store = store; }

 private JSONObject read() throws Exception {
  String raw = store.read();
  if (raw == null) return new JSONObject().put("version", 1).put("records", new JSONObject());
  JSONObject data = new JSONObject(raw);
  if (data.getInt("version") != 1) throw new IllegalStateException("Deletion journal unavailable");
  data.getJSONObject("records");
  return data;
 }

 private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }

 /** Exact structural JSON equality (key order ignored). */
 public static boolean same(Object a, Object b) throws Exception {
  if (a instanceof JSONObject && b instanceof JSONObject) {
   JSONObject x = (JSONObject) a, y = (JSONObject) b;
   if (x.length() != y.length()) return false;
   for (Iterator<String> i = x.keys(); i.hasNext();) { String key = i.next(); if (!y.has(key) || !same(x.get(key), y.get(key))) return false; }
   return true;
  }
  if (a instanceof JSONArray && b instanceof JSONArray) {
   JSONArray x = (JSONArray) a, y = (JSONArray) b;
   if (x.length() != y.length()) return false;
   for (int i = 0; i < x.length(); i++) if (!same(x.get(i), y.get(i))) return false;
   return true;
  }
  return Objects.equals(a, b);
 }

 /** open, expired or clock-changed for a persisted row. */
 public static String window(JSONObject row, String continuity, long elapsed) throws Exception {
  JSONObject d = row.getJSONObject("deadline");
  long start = d.getLong("createdElapsed"), expiry = d.getLong("expiresElapsed");
  if (!d.getString("continuity").equals(continuity) || elapsed < start) return "clock-changed";
  return elapsed < expiry ? "open" : "expired";
 }

 // Acknowledgement hides the notice only; its unknown receipt and no-replay state remain intact.
 public synchronized Set<String> acknowledgements() throws Exception {
  JSONObject marks = read().optJSONObject("acknowledgements");
  Set<String> keys = new HashSet<>();
  if (marks != null) for (Iterator<String> i = marks.keys(); i.hasNext();) { String key = i.next(); if (marks.optBoolean(key, false)) keys.add(key); }
  return keys;
 }

 public synchronized boolean acknowledged(String kind, String id) throws Exception {
  JSONObject marks = read().optJSONObject("acknowledgements");
  return marks != null && marks.optBoolean(kind + ":" + id, false);
 }

 public synchronized void acknowledge(String kind, String id) throws Exception {
  JSONObject data = read(), marks = data.optJSONObject("acknowledgements");
  if (marks == null) { marks = new JSONObject(); data.put("acknowledgements", marks); }
  if (marks.length() >= MAX_ACKNOWLEDGEMENTS && !marks.has(kind + ":" + id)) throw new IllegalStateException("Deletion acknowledgements require review");
  marks.put(kind + ":" + id, true);
  store.save(data.toString());
 }

 /** Stages one exact reviewed target. Restaging the same id with the same owner and target is idempotent. */
 public synchronized JSONObject stage(String id, JSONObject owner, JSONObject target, DeletionDeadline deadline) throws Exception {
  if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException("Deletion identity required");
  JSONObject data = read(), records = data.getJSONObject("records"), prior = records.optJSONObject(id);
  if (prior != null) {
   if (!same(owner, prior.getJSONObject("owner")) || !same(target, prior.getJSONObject("target"))) throw new IllegalArgumentException("Deletion identity changed");
   return copy(prior);
  }
  // Terminal entries may retire only after a new explicit review reaches stage.
  // Never evict unknown/dispatching/paused/pending intents. Reuse cannot bypass target guards.
  ArrayList<String> terminal = new ArrayList<>();
  for (Iterator<String> i = records.keys(); i.hasNext();) {
   String key = i.next(), phase = records.getJSONObject(key).getString("phase");
   if ("deleted".equals(phase) || "undone".equals(phase) || "conflict".equals(phase)) terminal.add(key);
  }
  terminal.sort((a, b) -> Long.compare(records.optJSONObject(a).optJSONObject("deadline").optLong("createdElapsed"), records.optJSONObject(b).optJSONObject("deadline").optLong("createdElapsed")));
  for (int i = 0; i < terminal.size() - RETAINED_TERMINAL; i++) records.remove(terminal.get(i));
  if (records.length() >= MAX_ROWS) throw new IllegalStateException("Pending deletion history requires review");
  JSONObject row = new JSONObject().put("version", 1).put("id", id).put("owner", copy(owner)).put("target", copy(target)).put("phase", "queued")
   .put("deadline", new JSONObject().put("continuity", deadline.continuity).put("createdElapsed", deadline.createdElapsed).put("expiresElapsed", deadline.expiresElapsed).put("expiresAt", deadline.expiresAt));
  records.put(id, row);
  // Count alone is insufficient when a retained event has a large description.
  String encoded = data.toString();
  int retired = 0;
  while (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_STAGED_BYTES && retired < terminal.size()) { records.remove(terminal.get(retired++)); encoded = data.toString(); }
  if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_STAGED_BYTES) throw new IllegalStateException("Active deletion history requires review");
  store.save(encoded);
  return copy(row);
 }

 /** Every row; queued rows carry their window and a dispatching row reads as unknown. */
 public synchronized JSONArray list(String continuity, long elapsed) throws Exception {
  JSONObject records = read().getJSONObject("records");
  JSONArray rows = new JSONArray();
  for (Iterator<String> i = records.keys(); i.hasNext();) {
   JSONObject row = copy(records.getJSONObject(i.next()));
   if ("queued".equals(row.getString("phase"))) row.put("window", window(row, continuity, elapsed));
   else if ("dispatching".equals(row.getString("phase"))) row.put("phase", "unknown");
   rows.put(row);
  }
  return rows;
 }

 public synchronized JSONObject undo(String id, JSONObject owner, String continuity, long elapsed) throws Exception {
  JSONObject data = read(), row = data.getJSONObject("records").getJSONObject(id);
  if (!same(owner, row.getJSONObject("owner"))) throw new SecurityException("Deletion owner changed");
  String phase = row.getString("phase");
  if (!"queued".equals(phase) && !"paused".equals(phase)) return requireUndone(copy(row));
  if (!"paused".equals(phase) && "expired".equals(window(row, continuity, elapsed))) throw new IllegalStateException("Undo window ended");
  row.put("phase", "undone");
  store.save(data.toString());
  return copy(row);
 }

 /** Undo succeeds only when the item was kept. A settled (deleted, conflicting or uncertain)
  * deletion is never reported back as a successful Undo. A repeated Undo stays successful. */
 public static JSONObject requireUndone(JSONObject row) throws Exception {
  if (!"undone".equals(row.optString("phase"))) throw new IllegalStateException("Undo window ended; deletion " + row.optString("phase", "unknown"));
  return row;
 }

 /** Dispatches one expired queued row at most once. A refused admission pauses it for review. */
 public synchronized JSONObject expire(String id, String continuity, long elapsed, Admission admission, Delete deletion) throws Exception {
  JSONObject data = read(), row = data.getJSONObject("records").getJSONObject(id);
  if (!"queued".equals(row.getString("phase")) || !"expired".equals(window(row, continuity, elapsed))) return copy(row);
  String refusal;
  try { refusal = admission.refusal(copy(row.getJSONObject("owner")), copy(row.getJSONObject("target"))); }
  catch (Exception unavailable) { refusal = "owner-unavailable"; }
  if (refusal != null) { row.put("phase", "paused").put("blocked", refusal); store.save(data.toString()); return copy(row); }
  row.remove("blocked");
  row.put("phase", "dispatching");
  store.save(data.toString());
  JSONObject outcome;
  try { outcome = deletion.apply(copy(row.getJSONObject("target"))); }
  catch (Exception unknown) { outcome = null; }
  if (outcome == null) outcome = new JSONObject().put("status", "unknown");
  String status = outcome.optString("status", "unknown");
  if (!OUTCOMES.contains(status)) status = "unknown";
  row.put("phase", "permission-required".equals(status) ? "paused" : status).put("outcome", outcome);
  if ("permission-required".equals(status)) row.put("blocked", status);
  store.save(data.toString());
  return copy(row);
 }
}

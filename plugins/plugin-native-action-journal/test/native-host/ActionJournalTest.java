import ai.eliza.plugins.actionjournal.ActionJournal;
import ai.eliza.plugins.actionjournal.ActionJournalConfiguration;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** JVM tests with an in-memory store and synthetic records only; no Android framework. */
public final class ActionJournalTest {
 private static int checks;
 private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
 private interface Failing { void run() throws Exception; }
 private static void refuses(Class<? extends Exception> type, Failing body) {
  checks++;
  try { body.run(); } catch (Exception error) { if (type.isInstance(error)) return; throw new AssertionError("Check " + checks + ": " + error); }
  throw new AssertionError("Check " + checks + " should have been refused");
 }

 static final class Memory implements ActionJournal.Storage {
  final Map<String, String> slots = new HashMap<>();
  String failOn;
  int writes;
  public String read(String slot) { return slots.get(slot); }
  public void write(String slot, String value) throws Exception {
   if (failOn != null && slot.contains(failOn)) throw new java.io.IOException("Synthetic write failure");
   writes++; slots.put(slot, value);
  }
 }

 static final String SCOPE = "a".repeat(64), HASH = "b".repeat(64), OTHER_HASH = "c".repeat(64);

 public static void main(String[] args) throws Exception {
  long[] now = {1000};
  Memory store = new Memory();
  ActionJournal.ResultPolicy policy = new ActionJournal.ResultPolicy() {
   public void check(JSONObject entry, String status, JSONObject result) throws Exception {
    if ("succeeded".equals(status) && result == null) throw new IllegalArgumentException("Success needs a receipt");
    ActionJournal.BOUNDED_RESULTS.check(entry, status, result);
   }
   public JSONObject listView(JSONObject entry) throws Exception {
    JSONObject copy = new JSONObject(entry.toString());
    JSONObject result = copy.optJSONObject("result");
    if (result != null && result.has("private")) { result.remove("private"); copy.put("privateRetained", true); }
    return copy;
   }
  };
  ActionJournal journal = new ActionJournal(new ActionJournalConfiguration("action-journal:v1", 3, 256, 40), store, policy, () -> now[0]);
  JSONObject record = new JSONObject().put("operation", new JSONObject().put("type", "create_note").put("title", "Synthetic"));

  // Slot identity is the configured namespace; a host keeps its existing slots when adopting the module.
  check(journal.indexSlot(SCOPE).equals("action-journal:v1:" + SCOPE + ":index"));
  check(journal.entrySlot(SCOPE, "p1").equals("action-journal:v1:" + SCOPE + ":entry:p1"));
  refuses(IllegalArgumentException.class, () -> journal.entrySlot("bad", "p1"));
  refuses(IllegalArgumentException.class, () -> journal.entrySlot(SCOPE, "../p1"));
  refuses(IllegalArgumentException.class, () -> new ActionJournalConfiguration("Bad Namespace", 1, 256, 1));
  refuses(IllegalArgumentException.class, () -> new ActionJournalConfiguration("ok", 0, 256, 1));

  // Reserve creates once; an identical replay returns the stored entry; a changed one is refused.
  ActionJournal.Reservation first = journal.reserve(SCOPE, "p1", "op-1", HASH, record);
  check(first.created && "reserved".equals(first.entry.getString("phase")) && first.entry.getLong("createdAt") == 1000);
  now[0] = 2000;
  ActionJournal.Reservation replay = journal.reserve(SCOPE, "p1", "op-1", HASH, new JSONObject(record.toString()));
  check(!replay.created && replay.entry.getLong("createdAt") == 1000);
  refuses(ActionJournal.Refused.class, () -> journal.reserve(SCOPE, "p1", "op-1", OTHER_HASH, record));
  refuses(ActionJournal.Refused.class, () -> journal.reserve(SCOPE, "p1", "op-1", HASH, new JSONObject().put("operation", "changed")));
  refuses(IllegalArgumentException.class, () -> journal.reserve(SCOPE, "p2", "op-2", HASH, new JSONObject().put("x", "y".repeat(300))));
  refuses(IllegalArgumentException.class, () -> journal.reserve(SCOPE, "p2", "op-2", "short", record));

  // Success requires a recorded dispatch; applying only follows reserved.
  refuses(ActionJournal.Refused.class, () -> journal.finish(SCOPE, "p1", "succeeded", "Done", new JSONObject().put("ok", true)));
  JSONObject applying = journal.markApplying(SCOPE, "p1", "attempt-1");
  check("applying".equals(applying.getString("phase")) && "attempt-1".equals(applying.getString("attemptId")));
  refuses(ActionJournal.Refused.class, () -> journal.markApplying(SCOPE, "p1", "attempt-2"));
  refuses(IllegalArgumentException.class, () -> journal.finish(SCOPE, "p1", "succeeded", "Done", null));
  refuses(IllegalArgumentException.class, () -> journal.finish(SCOPE, "p1", "maybe", "Done", null));
  refuses(IllegalArgumentException.class, () -> journal.finish(SCOPE, "p1", "failed", "x".repeat(41), null));
  refuses(IllegalArgumentException.class, () -> journal.finish(SCOPE, "p1", "succeeded", "Done", new JSONObject().put("readResult", "private")));
  JSONObject receipt = new JSONObject().put("ok", true).put("private", "synthetic body");
  JSONObject terminal = journal.finish(SCOPE, "p1", "succeeded", "Done", receipt);
  check("terminal".equals(terminal.getString("phase")) && "succeeded".equals(terminal.getString("status")));

  // The terminal state is final: an identical replay is returned, any other outcome is refused.
  int writes = store.writes;
  check(ActionJournal.sameJson(journal.finish(SCOPE, "p1", "succeeded", "Done", new JSONObject(receipt.toString())), terminal));
  check(store.writes == writes);
  refuses(ActionJournal.Refused.class, () -> journal.finish(SCOPE, "p1", "failed", "Done", null));
  refuses(ActionJournal.Refused.class, () -> journal.finish(SCOPE, "p1", "succeeded", "Other", receipt));
  refuses(ActionJournal.Refused.class, () -> journal.finish(SCOPE, "missing", "failed", "Never journaled", null));

  // A non-dispatched entry may end as failed, cancelled or unknown without a receipt.
  journal.reserve(SCOPE, "p2", "op-2", HASH, record);
  check("cancelled".equals(journal.finish(SCOPE, "p2", "cancelled", "Rejected", null).getString("status")));

  // The index commits before the entry: a failed entry write leaves a listed id with no entry,
  // which list() skips and a later identical reserve completes.
  store.failOn = ":entry:p3";
  refuses(java.io.IOException.class, () -> journal.reserve(SCOPE, "p3", "op-3", HASH, record));
  check(new JSONArray(store.read(journal.indexSlot(SCOPE))).length() == 3);
  check(journal.get(SCOPE, "p3") == null && journal.list(SCOPE).length() == 2);
  store.failOn = null;
  check(journal.reserve(SCOPE, "p3", "op-3", HASH, record).created);
  check(new JSONArray(store.read(journal.indexSlot(SCOPE))).length() == 3);

  // Bounded: a full index refuses new proposals but keeps existing replays working.
  refuses(ActionJournal.Refused.class, () -> journal.reserve(SCOPE, "p4", "op-4", HASH, record));
  check(!journal.reserve(SCOPE, "p3", "op-3", HASH, record).created);

  // Passive list goes through the host view and never rewrites stored private results.
  JSONArray listed = journal.list(SCOPE);
  check(listed.length() == 3 && "p1".equals(listed.getJSONObject(0).getString("proposalId")));
  check(listed.getJSONObject(0).optBoolean("privateRetained") && !listed.getJSONObject(0).getJSONObject("result").has("private"));
  check(journal.get(SCOPE, "p1").getJSONObject("result").has("private"));

  // Scopes are isolated.
  check(journal.list("d".repeat(64)).length() == 0 && journal.get("d".repeat(64), "p1") == null);

  // Host transitions run under the lock, may annotate, and can never change identity.
  JSONObject noted = journal.update(SCOPE, "p3", entry -> entry.put("hostMarker", new JSONObject().put("phase", "reviewing")));
  check(noted.has("hostMarker") && journal.get(SCOPE, "p3").has("hostMarker"));
  writes = store.writes;
  journal.update(SCOPE, "p3", entry -> entry);
  check(store.writes == writes);
  refuses(ActionJournal.Refused.class, () -> journal.update(SCOPE, "p3", entry -> entry.put("operationHash", OTHER_HASH)));
  refuses(ActionJournal.Refused.class, () -> journal.update(SCOPE, "p3", entry -> entry.put("record", new JSONObject())));
  refuses(ActionJournal.Refused.class, () -> journal.update(SCOPE, "absent", entry -> new JSONObject()));
  check(journal.update(SCOPE, "absent", entry -> entry) == null);
  check(HASH.equals(journal.get(SCOPE, "p3").getString("operationHash")));

  // Structural equality ignores key order and treats JSON null like absence only for null.
  check(ActionJournal.sameJson(new JSONObject("{\"a\":1,\"b\":[1,{\"c\":2}]}"), new JSONObject("{\"b\":[1,{\"c\":2}],\"a\":1}")));
  check(!ActionJournal.sameJson(new JSONObject("{\"a\":1}"), new JSONObject("{\"a\":2}")));
  check(!ActionJournal.sameJson(new JSONArray("[1,2]"), new JSONArray("[2,1]")));
  check(ActionJournal.sameJson(new JSONObject().put("n", 1000L), new JSONObject("{\"n\":1000}")));
  check(!ActionJournal.sameJson(new JSONObject().put("n", "1000"), new JSONObject("{\"n\":1000}")));

  // Concurrent reserves from two bridges of one process serialize on one journal.
  ActionJournal shared = new ActionJournal(ActionJournalConfiguration.standard("action-journal:v1"), new Memory(), ActionJournal.BOUNDED_RESULTS);
  int[] created = {0};
  Thread[] threads = new Thread[8];
  for (int i = 0; i < threads.length; i++) {
   threads[i] = new Thread(() -> { try { if (shared.reserve(SCOPE, "race", "op-race", HASH, record).created) synchronized (created) { created[0]++; } } catch (Exception error) { throw new RuntimeException(error); } });
   threads[i].start();
  }
  for (Thread thread : threads) thread.join();
  check(created[0] == 1 && shared.list(SCOPE).length() == 1);

  System.out.println(checks + " assertions passed");
 }
}

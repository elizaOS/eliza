// spec/os/android/deferredDeletion.md, "Story: Keep one winner between Undo and the provider"; spec/os/android/deferredDeletion.md, "Story: Undo a deleted message, conversation, voicemail or contact"; spec/os/android/deletionWindow.md, "Story: Undo a reviewed deletion before it is sent"
package ai.eliza.plugins.actionjournal.deletion;

import ai.eliza.plugins.actionjournal.ActionJournal;
import ai.eliza.plugins.actionjournal.ActionJournalConfiguration;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

public final class DeferredDeletionTest {
 private static int checks;
 private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
 private interface Failing { void run() throws Exception; }
 private static void refuses(Class<? extends Exception> type, Failing body) {
  checks++;
  try { body.run(); } catch (Exception error) { if (type.isInstance(error)) return; throw new AssertionError("Check " + checks + ": " + error); }
  throw new AssertionError("Check " + checks + " should have been refused");
 }
 private static JSONObject object(String id) throws Exception { return new JSONObject().put("id", id); }

 static final class Store implements DeferredDeletionJournal.Store {
  String saved; boolean fail;
  public String read() { return saved; }
  public void save(String value) { if (fail) throw new IllegalStateException("disk unavailable"); saved = value; }
 }

 public static void main(String[] args) throws Exception {
  deadline();
  journal();
  claimAndRecovery();
  coordinator();
  strictOwnerFence();
  records();
  System.out.println(checks + " assertions passed");
 }

 static void deadline() {
  DeletionDeadline d = new DeletionDeadline("boot:1", 100, 100000);
  check(DeletionDeadline.WINDOW_MS == 10000);
  check(d.expiresAt == 110000);
  check(DeletionDeadline.window(d.continuity, d.createdElapsed, d.expiresElapsed, "boot:1", 10099).equals("open"));
  check(DeletionDeadline.window(d.continuity, d.createdElapsed, d.expiresElapsed, "boot:1", 10100).equals("expired"));
  check(DeletionDeadline.window(d.continuity, d.createdElapsed, d.expiresElapsed, "boot:1", 99).equals("clock-changed"));
  check(DeletionDeadline.window(d.continuity, d.createdElapsed, d.expiresElapsed, "boot:2", 20000).equals("clock-changed"));
  refuses(IllegalArgumentException.class, () -> new DeletionDeadline("boot", Long.MAX_VALUE, 0));
  refuses(IllegalArgumentException.class, () -> new DeletionDeadline("", 0, 0));
 }

 static void journal() throws Exception {
  Store store = new Store();
  JSONObject owner = object("owner"), target = object("exact-event-revision");
  DeferredDeletionJournal j = new DeferredDeletionJournal(store);
  j.stage("undo", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  j = new DeferredDeletionJournal(store);
  check(j.undo("undo", owner, "boot", 9999).getString("phase").equals("undone"));
  AtomicInteger effects = new AtomicInteger();
  j.expire("undo", "boot", 20000, (a, b) -> null, t -> { effects.incrementAndGet(); return object("bad"); });
  check(effects.get() == 0);
  j.stage("expiry", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  j.expire("expiry", "other-boot", 999999, (a, b) -> null, t -> { effects.incrementAndGet(); return object("bad"); });
  check(effects.get() == 0);
  j.expire("expiry", "boot", 10100, (a, b) -> "owner-changed", t -> { effects.incrementAndGet(); return object("bad"); });
  check(effects.get() == 0);
  check(j.expire("expiry", "boot", 50000, (a, b) -> null, t -> { effects.incrementAndGet(); return object("bad"); }).getString("phase").equals("paused"));
  check(effects.get() == 0);
  check(j.undo("expiry", owner, "boot", 50000).getString("phase").equals("undone"));
  j.stage("write", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  store.fail = true;
  final DeferredDeletionJournal failing = j;
  refuses(IllegalStateException.class, () -> failing.expire("write", "boot", 10100, (a, b) -> null, t -> { effects.incrementAndGet(); return object("bad"); }));
  check(effects.get() == 0);
  store.fail = false;
  refuses(IllegalStateException.class, () -> failing.expire("write", "boot", 10100, (a, b) -> null, t -> { effects.incrementAndGet(); store.fail = true; return new JSONObject().put("status", "deleted"); }));
  store.fail = false;
  check(effects.get() == 1);
  j = new DeferredDeletionJournal(store);
  j.expire("write", "boot", 50000, (a, b) -> null, t -> { effects.incrementAndGet(); return new JSONObject().put("status", "deleted"); });
  check(effects.get() == 1);
  boolean unknown = false;
  JSONArray all = j.list("boot", 50000);
  for (int i = 0; i < all.length(); i++) unknown |= all.getJSONObject(i).getString("id").equals("write") && all.getJSONObject(i).getString("phase").equals("unknown");
  check(unknown);
  j.stage("reboot", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  check(j.undo("reboot", owner, "new-boot", 1).getString("phase").equals("undone"));
  j.stage("foreign", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  final DeferredDeletionJournal foreign = j;
  refuses(SecurityException.class, () -> foreign.undo("foreign", object("other"), "boot", 101));
  refuses(IllegalArgumentException.class, () -> foreign.stage("foreign", "calendar", owner, object("other-target"), new DeletionDeadline("boot", 1, 1)));
  check(j.expire("foreign", "boot", 10100, (a, b) -> null, t -> { effects.incrementAndGet(); throw new IllegalStateException("unknown transport"); }).getString("phase").equals("unknown"));
  j.expire("foreign", "boot", 50100, (a, b) -> null, t -> { effects.incrementAndGet(); return object("bad"); });
  check(effects.get() == 2);
  j.acknowledge("calendar", "foreign");
  check(j.acknowledged("calendar", "foreign"));
  check(!j.acknowledged("reminder", "foreign"));
  check(new DeferredDeletionJournal(store).acknowledgements().contains("calendar:foreign"));
  for (int n = 0; n < 20; n++) {
   DeferredDeletionJournal race = new DeferredDeletionJournal(new Store());
   race.stage("race", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
   CountDownLatch start = new CountDownLatch(1);
   AtomicInteger writes = new AtomicInteger(), lateUndo = new AtomicInteger();
   AtomicReference<Throwable> failure = new AtomicReference<>();
   Thread undo = new Thread(() -> { try { start.await(); race.undo("race", owner, "boot", 10099); } catch (IllegalStateException late) { lateUndo.incrementAndGet(); } catch (Throwable e) { failure.set(e); } });
   Thread expiry = new Thread(() -> { try { start.await(); race.expire("race", "boot", 10100, (a, b) -> null, t -> { writes.incrementAndGet(); return new JSONObject().put("status", "deleted"); }); } catch (Throwable e) { failure.set(e); } });
   undo.start(); expiry.start(); start.countDown(); undo.join(); expiry.join();
   if (failure.get() != null) throw new AssertionError(failure.get());
   String phase = race.list("boot", 20000).getJSONObject(0).getString("phase");
   check(phase.equals("undone") ? writes.get() == 0 && lateUndo.get() == 0 : phase.equals("deleted") && writes.get() == 1 && lateUndo.get() == 1);
  }
  DeferredDeletionJournal late = new DeferredDeletionJournal(new Store());
  late.stage("late", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  check(late.expire("late", "boot", 10100, (a, b) -> null, t -> new JSONObject().put("status", "deleted")).getString("phase").equals("deleted"));
  refuses(IllegalStateException.class, () -> late.undo("late", owner, "boot", 10099));
  late.stage("nullOutcome", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  check(late.expire("nullOutcome", "boot", 10100, (a, b) -> null, t -> null).getString("phase").equals("unknown"));
  late.stage("permission", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  JSONObject permission = late.expire("permission", "boot", 10100, (a, b) -> null, t -> new JSONObject().put("status", "permission-required"));
  check(permission.getString("phase").equals("paused") && permission.getString("blocked").equals("permission-required"));
  late.stage("twice", "calendar", owner, target, new DeletionDeadline("boot", 100, 1000));
  check(late.undo("twice", owner, "boot", 200).getString("phase").equals("undone"));
  check(late.undo("twice", owner, "boot", 200).getString("phase").equals("undone"));
  for (String settled : new String[] {"deleted", "conflict", "dispatching", "unknown", "queued"})
   refuses(IllegalStateException.class, () -> DeferredDeletionJournal.requireUndone(new JSONObject().put("phase", settled)));
  DeferredDeletionJournal bounded = new DeferredDeletionJournal(new Store());
  bounded.stage("uncertain", "calendar", owner, target, new DeletionDeadline("boot", 1, 1));
  bounded.expire("uncertain", "boot", 10001, (a, b) -> null, t -> { throw new IllegalStateException("lost response"); });
  for (int n = 0; n < 600; n++) { String id = "terminal_" + n; bounded.stage(id, "calendar", owner, target, new DeletionDeadline("boot", n + 10, n + 10)); bounded.undo(id, owner, "boot", n + 11); }
  JSONArray history = bounded.list("boot", 100000);
  check(history.length() <= 129);
  boolean kept = false;
  for (int i = 0; i < history.length(); i++) kept |= history.getJSONObject(i).getString("id").equals("uncertain");
  check(kept);
  Store largeStore = new Store();
  DeferredDeletionJournal large = new DeferredDeletionJournal(largeStore);
  JSONObject largeTarget = object("large").put("description", "x".repeat(256 * 1024));
  large.stage("keep_unknown", "calendar", owner, target, new DeletionDeadline("boot", 1, 1));
  large.expire("keep_unknown", "boot", 10001, (a, b) -> null, t -> { throw new IllegalStateException("lost response"); });
  for (int n = 0; n < 20; n++) {
   String id = "large_" + n;
   large.stage(id, "calendar", owner, largeTarget, new DeletionDeadline("boot", n + 10, n + 10));
   large.undo(id, owner, "boot", n + 11);
   check(largeStore.saved.getBytes(StandardCharsets.UTF_8).length <= DeferredDeletionJournal.MAX_STAGED_BYTES);
  }
  boolean retainedUnknown = false;
  JSONArray largeRows = large.list("boot", 99999);
  for (int n = 0; n < largeRows.length(); n++) retainedUnknown |= largeRows.getJSONObject(n).getString("id").equals("keep_unknown");
  check(retainedUnknown);
  check(largeRows.length() < 20);
  DeferredDeletionJournal rebooted = new DeferredDeletionJournal(new Store());
  for (int n = 0; n < 10; n++) { String id = "before_" + n; rebooted.stage(id, "calendar", owner, target, new DeletionDeadline("boot:1", 1000000 + n, n + 1)); rebooted.undo(id, owner, "boot:1", 1000000 + n); }
  for (int n = 0; n < DeferredDeletionJournal.RETAINED_TERMINAL; n++) { String id = "after_" + n; rebooted.stage(id, "calendar", owner, target, new DeletionDeadline("boot:2", n + 1, 1000000 + n)); rebooted.undo(id, owner, "boot:2", n + 1); }
  rebooted.stage("latest", "calendar", owner, target, new DeletionDeadline("boot:2", 500, 2000000));
  JSONArray retainedRows = rebooted.list("boot:2", 600);
  check(retainedRows.length() == DeferredDeletionJournal.RETAINED_TERMINAL + 1);
  for (int n = 0; n < retainedRows.length(); n++) check(!retainedRows.getJSONObject(n).getString("id").startsWith("before_"));
  DeferredDeletionJournal crowded = new DeferredDeletionJournal(new Store());
  for (int n = 0; n < 20; n++) { String id = "kept_" + n; crowded.stage(id, "calendar", owner, target, new DeletionDeadline("boot", n + 1, n + 1)); crowded.undo(id, owner, "boot", n + 1); }
  for (int n = 0; n < DeferredDeletionJournal.MAX_ROWS - 20; n++) crowded.stage("open_" + n, "calendar", owner, target, new DeletionDeadline("boot", 100 + n, 100 + n));
  check(crowded.list("boot", 200).length() == DeferredDeletionJournal.MAX_ROWS);
  crowded.stage("one_more", "calendar", owner, target, new DeletionDeadline("boot", 1000, 1000));
  JSONArray crowdedRows = crowded.list("boot", 1000);
  check(crowdedRows.length() == DeferredDeletionJournal.MAX_ROWS);
  boolean staged = false, oldestKept = false;
  for (int n = 0; n < crowdedRows.length(); n++) { String id = crowdedRows.getJSONObject(n).getString("id"); staged |= id.equals("one_more"); oldestKept |= id.equals("kept_0"); }
  check(staged && !oldestKept);
  DeferredDeletionJournal unresolved = new DeferredDeletionJournal(new Store());
  for (int n = 0; n < DeferredDeletionJournal.MAX_ROWS; n++) unresolved.stage("open_" + n, "calendar", owner, target, new DeletionDeadline("boot", n + 1, n + 1));
  checks++;
  try { unresolved.stage("refused", "calendar", owner, target, new DeletionDeadline("boot", 1000, 1000)); throw new AssertionError("Check " + checks + " should have been refused"); }
  catch (IllegalStateException full) { if (!"Too many unresolved deletions. Resolve pending deletions before deleting more.".equals(full.getMessage())) throw new AssertionError("Check " + checks + ": " + full); }
 }

 static void claimAndRecovery() throws Exception {
  Map<String, String> memory = new HashMap<>();
  ActionJournal journal = new ActionJournal(ActionJournalConfiguration.standard("fixture"), new ActionJournal.Storage() {
   public String read(String key) { return memory.get(key); }
   public void write(String key, String value) { memory.put(key, value); }
  }, (entry, status, result) -> {});
  String scope = "a".repeat(64), hash = "b".repeat(64);
  JSONObject identity = new JSONObject().put("scope", scope).put("proposalId", "proposal");
  JSONObject operation = new JSONObject().put("type", "calendar_delete").put("target", new JSONObject().put("revision", "exact"));
  JSONObject owner = new JSONObject().put("kind", "agent").put("identity", new JSONObject().put("subjectUserId", "owner").put("agentId", "agent").put("installationId", "install").put("enrollmentId", "enrollment"));
  JSONObject record = new JSONObject().put("operation", operation).put("expiresAt", System.currentTimeMillis() + 60000).put("context", new JSONObject().put("sensitive", false)).put("ownerId", "owner").put("agentId", "agent").put("installationId", "install").put("enrollmentId", "enrollment");
  journal.reserve(scope, "proposal", "operation", hash, record);
  refuses(SecurityException.class, () -> DeletionDispatchClaim.check(journal, identity, "operation", operation, owner, false));
  journal.markApplying(scope, "proposal", "attempt");
  JSONObject stale = journal.get(scope, "proposal");
  JSONObject foreign = new JSONObject(owner.toString());
  foreign.getJSONObject("identity").put("subjectUserId", "other");
  refuses(SecurityException.class, () -> DeletionDispatchClaim.check(journal, identity, "operation", operation, foreign, false));
  JSONObject changed = new JSONObject(operation.toString());
  changed.getJSONObject("target").put("revision", "other");
  refuses(SecurityException.class, () -> DeletionDispatchClaim.check(journal, identity, "operation", changed, owner, false));
  refuses(SecurityException.class, () -> DeletionDispatchClaim.binding(journal, identity));
  DeletionDispatchClaim.check(journal, identity, "operation", operation, owner, false);
  check(!journal.get(scope, "proposal").has("nativeDispatchClaim"));
  DeletionDispatchClaim.check(journal, identity, "operation", operation, owner, true);
  refuses(SecurityException.class, () -> DeletionDispatchClaim.check(journal, identity, "operation", operation, owner, true));
  refuses(ActionJournal.Refused.class, () -> journal.update(scope, "proposal", current -> stale));
  refuses(ActionJournal.Refused.class, () -> journal.update(scope, "proposal", current -> { current.getJSONObject("nativeDispatchClaim").put("operationId", "replacement"); return current; }));
  JSONObject stagedTarget = new JSONObject(operation.getJSONObject("target").toString()).put("sourceId", "calendar").put("eventId", "event").put("journalBinding", DeletionDispatchClaim.binding(journal, identity));
  JSONObject receipt = new JSONObject().put("id", "operation").put("owner", owner).put("target", stagedTarget).put("phase", "deleted").put("outcome", new JSONObject().put("status", "deleted"));
  JSONObject claimed = journal.get(scope, "proposal");
  for (String field : new String[] {"scope", "proposalId", "operationHash"}) {
   JSONObject wrong = new JSONObject(receipt.toString());
   wrong.getJSONObject("target").getJSONObject("journalBinding").put(field, "wrong");
   check(DeletionReceiptRecovery.recover(claimed, wrong, null) == claimed);
  }
  JSONObject wrongClaim = new JSONObject(claimed.toString());
  wrongClaim.getJSONObject("nativeDispatchClaim").put("operationId", "wrong");
  check(DeletionReceiptRecovery.recover(wrongClaim, receipt, null) == wrongClaim);
  JSONObject otherOwner = new JSONObject(receipt.toString()).put("owner", foreign);
  check(DeletionReceiptRecovery.recover(claimed, otherOwner, null) == claimed);
  JSONObject recovered = DeletionReceiptRecovery.recover(claimed, receipt, null);
  check(recovered.getString("status").equals("succeeded"));
  check(recovered.getJSONObject("result").getJSONObject("calendarResult").getString("revision").equals("exact"));
  check(DeletionReceiptRecovery.recover(recovered, receipt, null) == recovered);
  JSONObject undone = new JSONObject(receipt.toString()).put("phase", "undone");
  JSONObject retained = DeletionReceiptRecovery.recover(claimed, undone, null);
  check(retained.getString("status").equals("failed"));
  check(!retained.getJSONObject("result").has("calendarResult"));
  check(DeletionReceiptRecovery.recover(claimed, new JSONObject(receipt.toString()).put("phase", "unknown"), null) == claimed);
  check(DeletionReceiptRecovery.recover(claimed, new JSONObject(receipt.toString()).put("outcome", new JSONObject().put("status", "unknown")), null) == claimed);
  journal.finish(scope, "proposal", "unknown", "Lost staging response", null);
  check(journal.get(scope, "proposal").has("nativeDispatchClaim"));
  refuses(SecurityException.class, () -> DeletionDispatchClaim.check(journal, identity, "operation", operation, owner, false));
 }

 static final class Ports implements DeferredDeletionCoordinator.Slots, DeferredDeletionCoordinator.Clock, DeferredDeletionCoordinator.Owners, DeferredDeletionCoordinator.Reminders, DeferredDeletionCoordinator.CalendarDeletions, DeferredDeletionCoordinator.Records, DeferredDeletionCoordinator.Scheduler {
  final Map<String, String> slots = new HashMap<>();
  final Map<String, Integer> slotReads = new HashMap<>();
  String boot = "boot:1"; long elapsed = 1000;
  JSONObject identity; String fence = "fence-1"; boolean offline; int identityReads; long identityDelay;
  boolean strictFence; int fenceReads, rotateAtFence = -1;
  DeferredDeletionCoordinator coordinator;
  final List<Long> scheduled = new ArrayList<>();
  final List<String> dispatched = new ArrayList<>();
  JSONObject outcome;
  final Map<String, JSONObject> reminderRows = new HashMap<>();
  final List<String> settled = new ArrayList<>(), paused = new ArrayList<>();
  Ports() throws Exception {
   identity = new JSONObject().put("subjectUserId", "owner").put("agentId", "agent").put("installationId", "install").put("enrollmentId", "enrollment").put("accountRef", "account").put("environment", "production").put("sessionId", "s1");
   outcome = new JSONObject().put("status", "deleted");
  }
  public String read(String slot) { slotReads.merge(slot, 1, Integer::sum); return slots.get(slot); }
  public void write(String slot, String value) { slots.put(slot, value); }
  public String continuity() { return boot; }
  public long elapsed() { return elapsed; }
  public long wall() { return 1700000000000L + elapsed; }
  public JSONObject identity() throws Exception {
   identityReads++;
   if (coordinator != null && Thread.holdsLock(coordinator)) throw new AssertionError("Owner route read under the coordinator lock");
   if (offline) throw new java.io.IOException("owner offline");
   elapsed += identityDelay;
   return new JSONObject(identity.toString());
  }
  public String reviewFence(JSONObject value) throws Exception {
   fenceReads++;
   if (fenceReads == rotateAtFence) identity.put("sessionId", "raced-session");
   if (strictFence && !DeferredDeletionJournal.same(value, identity)) throw new SecurityException("Retired owner identity");
   return fence + ":" + identity.optString("sessionId");
  }
  public JSONArray pendingDeletions() throws Exception { JSONArray rows = new JSONArray(); for (JSONObject row : reminderRows.values()) rows.put(new JSONObject(row.toString())); return rows; }
  public JSONObject stageDeletion(String id, String owner, JSONObject target, JSONObject clock, JSONObject binding) throws Exception {
   JSONObject row = new JSONObject().put("id", id).put("owner", owner).put("target", target).put("phase", "queued").put("continuity", clock.getString("continuity")).put("createdElapsed", clock.getLong("elapsed")).put("expiresElapsed", clock.getLong("elapsed") + DeletionDeadline.WINDOW_MS).put("delivery", "suspended");
   reminderRows.put(id, row);
   return new JSONObject(row.toString());
  }
  public JSONObject settleDeletion(String id, String owner, JSONObject clock, boolean undo) throws Exception {
   JSONObject row = reminderRows.get(id);
   if (!row.getString("owner").equals(owner)) throw new SecurityException();
   settled.add(id + ":" + undo);
   String phase = row.getString("phase");
   if ("queued".equals(phase) || "paused".equals(phase)) row.put("phase", undo ? "undone" : "deleted").put("effects", "complete");
   return new JSONObject(row.toString());
  }
  public void pauseDeletion(String id, String owner, String reason) throws Exception { paused.add(id + ":" + reason); reminderRows.get(id).put("phase", "paused").put("blocked", reason); }
  public JSONObject reminder(String id) throws Exception {
   for (JSONObject row : reminderRows.values()) if (id.equals(row.getJSONObject("target").optString("reminderId"))) return new JSONObject().put("status", "deleted".equals(row.optString("phase")) ? "cancelled" : "active").put("occurrenceId", row.getJSONObject("target").optString("occurrenceId"));
   return null;
  }
  public String refusal(JSONObject owner, JSONObject target) { return target.optBoolean("refuse") ? "sync-context-changed" : null; }
  public JSONObject dispatch(JSONObject target) throws Exception { dispatched.add(target.getString("eventId")); if (outcome == null) throw new java.io.IOException("lost"); return outcome; }
  public boolean targets(JSONObject target, long source, long event) { return Long.toString(event).equals(target.optString("eventId")); }
  public void schedule(long delay) { scheduled.add(delay); }
  final List<String> recordDispatched = new ArrayList<>();
  final Map<String, String> recordRefusals = new HashMap<>();
  final Map<String, JSONObject> recordOutcomes = new HashMap<>();
  boolean recordLost;
  public String refusal(String kind, JSONObject owner, JSONObject target) { return recordRefusals.get(kind); }
  public JSONObject dispatch(String kind, JSONObject target) throws Exception {
   recordDispatched.add(kind + ":" + target.getString("id"));
   if (recordLost) throw new java.io.IOException("lost");
   JSONObject reported = recordOutcomes.get(kind);
   return reported == null ? new JSONObject().put("status", "deleted") : reported;
  }
 }

 static DeferredDeletionCoordinator coordinator(Ports ports) {
  DeferredDeletionCoordinator coordinator = new DeferredDeletionCoordinator(new DeferredDeletionCoordinator.Configuration("native-delete-journal:v1", "native-delete-installation:v1"), ports, ports, ports, ports, ports, ports, ports);
  ports.coordinator = coordinator;
  return coordinator;
 }

 static void strictOwnerFence() throws Exception {
  Ports changed = new Ports(); changed.strictFence = true;
  DeferredDeletionCoordinator c = coordinator(changed);
  JSONObject owner = c.agentOwner();
  c.stageCalendar(event("strict-calendar"), owner, "strict-calendar");
  c.stageReminder(reminder("strict-reminder"), owner, "strict-reminder", null);
  changed.identity.put("sessionId", "new-session");
  changed.elapsed += DeletionDeadline.WINDOW_MS;
  int reads = changed.fenceReads;
  check(!c.reconcile());
  check(changed.fenceReads == reads + 1);
  check(c.receipt("calendar", "strict-calendar").getString("phase").equals("paused"));
  check(c.receipt("calendar", "strict-calendar").getString("blocked").equals("owner-changed"));
  check(changed.paused.equals(List.of("strict-reminder:owner-changed")));
  check(changed.dispatched.isEmpty() && changed.settled.isEmpty());
  check(!c.reconcile());
  check(changed.paused.size() == 1 && changed.dispatched.isEmpty() && changed.settled.isEmpty());

  Ports raced = new Ports(); raced.strictFence = true;
  DeferredDeletionCoordinator r = coordinator(raced);
  JSONObject beforeRace = r.agentOwner();
  r.stageCalendar(event("race-calendar"), beforeRace, "race-calendar");
  r.stageReminder(reminder("race-reminder"), beforeRace, "race-reminder", null);
  raced.elapsed += DeletionDeadline.WINDOW_MS;
  raced.rotateAtFence = raced.fenceReads + 2;
  check(r.reconcile());
  check(r.receipt("calendar", "race-calendar").getString("phase").equals("paused"));
  check(r.receipt("calendar", "race-calendar").getString("blocked").equals("owner-unavailable"));
  check(raced.reminderRows.get("race-reminder").getString("phase").equals("queued"));
  check(raced.dispatched.isEmpty() && raced.settled.isEmpty() && raced.paused.isEmpty());
  check(!r.reconcile());
  check(r.receipt("calendar", "race-calendar").getString("phase").equals("paused"));
  check(raced.paused.equals(List.of("race-reminder:owner-changed")));
  check(raced.dispatched.isEmpty() && raced.settled.isEmpty());

  Ports same = new Ports(); same.strictFence = true;
  DeferredDeletionCoordinator s = coordinator(same);
  JSONObject current = s.agentOwner();
  s.stageCalendar(event("same-calendar"), current, "same-calendar");
  s.stageReminder(reminder("same-reminder"), current, "same-reminder", null);
  same.elapsed += DeletionDeadline.WINDOW_MS;
  check(!s.reconcile());
  check(same.dispatched.equals(List.of("same-calendar")));
  check(same.settled.equals(List.of("same-reminder:false")) && same.paused.isEmpty());
  check(!s.reconcile());
  check(same.dispatched.size() == 1 && same.settled.size() == 1);
 }

 static JSONObject event(String id) throws Exception { return new JSONObject().put("version", 3).put("sourceId", "7").put("eventId", id).put("revision", "r1").put("fields", new JSONObject().put("title", "Standup")); }
 static JSONObject reminder(String id) throws Exception { return new JSONObject().put("sourceId", "local").put("reminderId", id).put("occurrenceId", id + "@1").put("row", new JSONObject().put("title", "Pills")); }

 static void coordinator() throws Exception {
  refuses(IllegalArgumentException.class, () -> new DeferredDeletionCoordinator.Configuration("same", "same"));
  Ports ports = new Ports();
  DeferredDeletionCoordinator c = coordinator(ports);
  JSONObject manual = c.manualOwner();
  check(manual.getString("kind").equals("manual") && manual.toString().equals(c.manualOwner().toString()));
  check(ports.slots.containsKey("native-delete-installation:v1"));
  c.stageCalendar(event("11"), manual, "op_calendar");
  check(ports.scheduled.get(ports.scheduled.size() - 1) == 0);
  check(c.calendarPending(7, 11) && !c.calendarPending(7, 12) && !c.calendarPending(8, 11));
  JSONArray pending = c.pending();
  check(pending.length() == 1 && pending.getJSONObject(0).getString("kind").equals("calendar") && pending.getJSONObject(0).getString("window").equals("open"));
  check(!c.reconcile());
  check(ports.dispatched.isEmpty());
  check(ports.scheduled.get(ports.scheduled.size() - 1) == DeletionDeadline.WINDOW_MS);
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c = coordinator(ports);
  check(!c.reconcile());
  check(ports.dispatched.size() == 1);
  check(c.receipt("calendar", "op_calendar").getString("phase").equals("deleted"));
  check(!c.reconcile());
  check(ports.dispatched.size() == 1);
  check(!c.calendarPending(7, 11));
  final DeferredDeletionCoordinator settledCoordinator = c;
  refuses(IllegalStateException.class, () -> settledCoordinator.undo("calendar", "op_calendar"));
  c.stageCalendar(event("12"), manual, "op_undo");
  check(c.undo("calendar", "op_undo").getString("phase").equals("undone"));
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  check(ports.dispatched.size() == 1);
  c.stageCalendar(event("13"), manual, "op_reboot");
  ports.boot = "boot:2";
  ports.elapsed += DeletionDeadline.WINDOW_MS * 5;
  c.reconcile();
  check(ports.dispatched.size() == 1);
  check(c.pending().getJSONObject(0).getString("window").equals("clock-changed"));
  check(c.undo("calendar", "op_reboot").getString("phase").equals("undone"));
  JSONObject refused = event("14").put("refuse", true);
  c.stageCalendar(refused, manual, "op_refused");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  JSONObject pausedRow = c.receipt("calendar", "op_refused");
  check(pausedRow.getString("phase").equals("paused") && pausedRow.getString("blocked").equals("sync-context-changed"));
  check(ports.dispatched.size() == 1);
  check(c.undo("calendar", "op_refused").getString("phase").equals("undone"));
  ports.outcome = null;
  c.stageCalendar(event("15"), manual, "op_lost");
  final DeferredDeletionCoordinator active = c;
  refuses(IllegalStateException.class, () -> active.dismiss("calendar", "op_lost"));
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  check(ports.dispatched.size() == 2);
  c.reconcile();
  check(ports.dispatched.size() == 2);
  check(c.receipt("calendar", "op_lost").getString("phase").equals("unknown"));
  check(c.dismiss("calendar", "op_lost").getString("status").equals("acknowledged"));
  check(c.receipt("calendar", "op_lost").getString("phase").equals("unknown"));
  for (int i = 0; i < c.pending().length(); i++) check(!c.pending().getJSONObject(i).getString("id").equals("op_lost"));
  refuses(IllegalArgumentException.class, () -> active.dismiss("note", "op_lost"));
  ports.outcome = new JSONObject().put("status", "deleted");

  JSONObject agent = c.agentOwner();
  check(agent.getString("kind").equals("agent") && agent.getString("reviewFence").equals("fence-1:s1"));
  check(c.stageAdmissible(agent));
  c.stageCalendar(event("21"), agent, "op_agent");
  ports.offline = true;
  check(c.pending().length() == 0);
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  int reads = ports.identityReads;
  check(c.reconcile());
  check(ports.identityReads > reads);
  check(c.receipt("calendar", "op_agent").getString("phase").equals("queued"));
  check(ports.dispatched.size() == 2);
  ports.elapsed += DeferredDeletionCoordinator.OWNER_RETRY_MS;
  c.reconcile();
  check(c.receipt("calendar", "op_agent").getString("phase").equals("paused"));
  check(c.receipt("calendar", "op_agent").getString("blocked").equals("owner-unavailable"));
  check(ports.dispatched.size() == 2);
  final DeferredDeletionCoordinator offline = coordinator(ports);
  refuses(SecurityException.class, () -> offline.undo("calendar", "op_agent"));
  c = coordinator(ports);
  ports.offline = false;
  ports.identity.put("sessionId", "s2");
  check(!c.stageAdmissible(agent));
  refuses(SecurityException.class, () -> offline.stageCalendar(event("22"), agent, "op_stale_fence"));
  check(c.receipt("calendar", "op_stale_fence") == null);
  ports.elapsed += 6000;
  boolean shown = false;
  JSONArray rows = c.pending();
  for (int i = 0; i < rows.length(); i++) shown |= rows.getJSONObject(i).getString("id").equals("op_agent");
  check(shown);
  check(c.undo("calendar", "op_agent").getString("phase").equals("undone"));
  JSONObject current = c.agentOwner();
  c.stageCalendar(event("23"), current, "op_other");
  ports.identity.put("enrollmentId", "enrollment-2");
  ports.elapsed += 6000;
  rows = c.pending();
  for (int i = 0; i < rows.length(); i++) check(!rows.getJSONObject(i).getString("id").equals("op_other"));
  final DeferredDeletionCoordinator other = c;
  refuses(SecurityException.class, () -> other.undo("calendar", "op_other"));
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  check(c.receipt("calendar", "op_other").getString("phase").equals("paused"));
  check(c.receipt("calendar", "op_other").getString("blocked").equals("owner-changed"));
  check(ports.dispatched.size() == 2);
  ports.identity.put("enrollmentId", "enrollment");

  JSONObject staged = c.stageReminder(reminder("r1"), manual, "op_reminder", null);
  check(staged.getString("delivery").equals("suspended"));
  JSONArray reminderRows = c.pending();
  JSONObject reminderNotice = null;
  for (int i = 0; i < reminderRows.length(); i++) if (reminderRows.getJSONObject(i).getString("id").equals("op_reminder")) reminderNotice = reminderRows.getJSONObject(i);
  check(reminderNotice != null && reminderNotice.getString("kind").equals("reminder") && reminderNotice.getString("window").equals("open"));
  check(c.deletedNoteOrigins().length() == 0);
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  check(ports.settled.contains("op_reminder:false"));
  JSONArray origins = c.deletedNoteOrigins();
  check(origins.length() == 1 && origins.getJSONObject(0).getString("id").equals("r1") && origins.getJSONObject(0).getString("kind").equals("reminder"));
  final DeferredDeletionCoordinator reminders = c;
  refuses(IllegalStateException.class, () -> reminders.undo("reminder", "op_reminder"));
  c.stageReminder(reminder("r2"), manual, "op_reminder_undo", null);
  check(c.undo("reminder", "op_reminder_undo").getString("phase").equals("undone"));
  c.stageReminder(reminder("r3"), c.agentOwner(), "op_reminder_agent", null);
  ports.offline = true;
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  check(c.reconcile());
  check(ports.paused.isEmpty() && !ports.settled.contains("op_reminder_agent:false"));
  check(ports.reminderRows.get("op_reminder_agent").getString("phase").equals("queued"));
  ports.offline = false;
  check(!c.reconcile());
  check(ports.settled.contains("op_reminder_agent:false"));
  c.stageReminder(reminder("r5"), c.agentOwner(), "op_reminder_other", null);
  c.stageReminder(reminder("r6"), c.agentOwner(), "op_reminder_lost", null);
  ports.identity.put("enrollmentId", "enrollment-2");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  ports.reminderRows.get("op_reminder_lost").put("expiresElapsed", ports.elapsed - DeferredDeletionCoordinator.OWNER_RETRY_MS);
  c.reconcile();
  check(ports.paused.contains("op_reminder_other:owner-changed") && ports.paused.contains("op_reminder_lost:owner-changed"));
  ports.identity.put("enrollmentId", "enrollment");
  c.stageReminder(reminder("r7"), c.agentOwner(), "op_reminder_unreachable", null);
  ports.offline = true;
  ports.elapsed += DeletionDeadline.WINDOW_MS + DeferredDeletionCoordinator.OWNER_RETRY_MS;
  c.reconcile();
  check(ports.paused.contains("op_reminder_unreachable:owner-unavailable"));
  ports.offline = false;
  refuses(SecurityException.class, () -> reminders.undo("reminder", "missing"));

  JSONObject rotated = c.agentOwner();
  ports.reminderRows.put("op_effects", new JSONObject().put("id", "op_effects").put("owner", rotated.toString()).put("target", reminder("r4")).put("phase", "deleted").put("effects", "pending"));
  ports.fence = "fence-2";
  check(!c.reconcile());
  check(ports.settled.contains("op_effects:false"));
  ports.settled.clear();
  ports.offline = true;
  check(c.reconcile());
  check(ports.settled.isEmpty());
  ports.offline = false;
  ports.fence = "fence-1";
  ports.reminderRows.remove("op_effects");
  undoArrival();
  ownerReadsOnce();
  noticeReadsOnce();
 }

 static void undoArrival() throws Exception {
  Ports ports = new Ports();
  DeferredDeletionCoordinator c = coordinator(ports);
  JSONObject agent = c.agentOwner();
  c.stageCalendar(event("31"), agent, "op_cached");
  c.stageCalendar(event("32"), agent, "op_slow");
  int reads = ports.identityReads;
  check(c.undo("calendar", "op_cached").getString("phase").equals("undone"));
  check(ports.identityReads == reads);
  ports.elapsed += DeletionDeadline.WINDOW_MS - 10;
  ports.identityDelay = 1000;
  DeferredDeletionCoordinator fresh = coordinator(ports);
  check(fresh.undo("calendar", "op_slow").getString("phase").equals("undone"));
  check(ports.identityReads == reads + 1 && ports.elapsed >= 1000 + DeletionDeadline.WINDOW_MS);
 }

 static void ownerReadsOnce() throws Exception {
  Ports ports = new Ports();
  DeferredDeletionCoordinator c = coordinator(ports);
  JSONObject agent = c.agentOwner();
  for (int n = 0; n < 5; n++) c.stageCalendar(event("4" + n), agent, "op_hidden_" + n);
  ports.offline = true;
  int reads = ports.identityReads;
  check(c.pending().length() == 0);
  check(ports.identityReads == reads + 1);
  check(c.pending().length() == 0);
  check(ports.identityReads == reads + 1);
  ports.offline = false;
  ports.elapsed += 5000;
  check(c.pending().length() == 5);
 }

 static void noticeReadsOnce() throws Exception {
  Ports ports = new Ports();
  DeferredDeletionCoordinator c = coordinator(ports);
  JSONObject manual = c.manualOwner();
  for (int n = 0; n < 6; n++) { c.stageReminder(reminder("t" + n), manual, "op_terminal_" + n, null); }
  c.stageCalendar(event("51"), manual, "op_listed");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  c.reconcile();
  c.stageReminder(reminder("t9"), manual, "op_open", null);
  ports.slotReads.clear();
  JSONObject notice = c.pendingWithOrigins();
  check(notice.getJSONArray("deletedNoteOrigins").length() == 6);
  check(notice.getJSONArray("pending").length() == 1 && notice.getJSONArray("pending").getJSONObject(0).getString("id").equals("op_open"));
  check(ports.slotReads.get("native-delete-installation:v1") == 1);
  check(ports.slotReads.get("native-delete-journal:v1") == 1);
  ports.slotReads.clear();
  check(c.pending().length() == 1);
  check(ports.slotReads.get("native-delete-journal:v1") == 1 && ports.slotReads.get("native-delete-installation:v1") == 1);
  ports.slotReads.clear();
  check(c.deletedNoteOrigins().length() == 6);
  check(ports.slotReads.get("native-delete-installation:v1") == 1);
 }

 static final String[] RECORD_KINDS = {"message", "thread", "voicemail", "contact"};

 static JSONObject record(String id) throws Exception { return new JSONObject().put("id", id).put("revision", "r1"); }

 static JSONObject pendingRow(DeferredDeletionCoordinator c, String id) throws Exception {
  JSONArray rows = c.pending();
  for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).getString("id").equals(id)) return rows.getJSONObject(i);
  return null;
 }

 static void records() throws Exception {
  check(DeferredDeletionCoordinator.RECORD_KINDS.equals(new java.util.HashSet<>(List.of(RECORD_KINDS))));
  Ports ports = new Ports();
  DeferredDeletionCoordinator c = coordinator(ports);
  JSONObject manual = c.manualOwner();
  for (String other : new String[] {"calendar", "reminder", "note", ""})
   refuses(IllegalArgumentException.class, () -> c.stageRecord(other, record("refused"), manual, "op_refused_kind"));
  check(c.pending().length() == 0);
  for (String kind : RECORD_KINDS) {
   String id = "op_" + kind;
   JSONObject staged = c.stageRecord(kind, record(kind), manual, id);
   check(staged.getString("kind").equals(kind) && staged.getString("phase").equals("queued"));
   check(ports.scheduled.get(ports.scheduled.size() - 1) == 0);
   check(DeferredDeletionJournal.same(c.stageRecord(kind, record(kind), manual, id), staged));
   refuses(IllegalArgumentException.class, () -> c.stageRecord(kind, record("another"), manual, id));
   refuses(IllegalArgumentException.class, () -> c.stageRecord(kind.equals("message") ? "thread" : "message", record(kind), manual, id));
   refuses(IllegalArgumentException.class, () -> c.stageCalendar(record(kind), manual, id));
   JSONObject shown = pendingRow(c, id);
   check(shown != null && shown.getString("kind").equals(kind) && shown.getString("window").equals("open"));
   check(c.receipt(kind, id).getString("phase").equals("queued"));
   check(c.receipt("calendar", id) == null);
   refuses(SecurityException.class, () -> c.undo("calendar", id));
  }
  check(c.pending().length() == RECORD_KINDS.length);
  check(!c.reconcile());
  check(ports.recordDispatched.isEmpty() && ports.dispatched.isEmpty());
  check(c.undo("voicemail", "op_voicemail").getString("phase").equals("undone"));
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  ports.recordRefusals.put("contact", "contacts-grant-revoked");
  DeferredDeletionCoordinator restarted = coordinator(ports);
  check(!restarted.reconcile());
  List<String> sent = new ArrayList<>(ports.recordDispatched);
  java.util.Collections.sort(sent);
  check(sent.equals(List.of("message:message", "thread:thread")));
  check(ports.dispatched.isEmpty());
  check(restarted.receipt("message", "op_message").getString("phase").equals("deleted"));
  check(restarted.receipt("thread", "op_thread").getString("phase").equals("deleted"));
  check(restarted.receipt("voicemail", "op_voicemail").getString("phase").equals("undone"));
  JSONObject held = restarted.receipt("contact", "op_contact");
  check(held.getString("phase").equals("paused") && held.getString("blocked").equals("contacts-grant-revoked"));
  check(!restarted.reconcile());
  check(ports.recordDispatched.size() == 2);
  refuses(IllegalStateException.class, () -> restarted.undo("message", "op_message"));
  check(restarted.undo("contact", "op_contact").getString("phase").equals("undone"));
  check(restarted.pending().length() == 0);
  ports.recordRefusals.clear();

  JSONObject own = restarted.stageRecord("message", record("own"));
  check(own.getString("kind").equals("message") && DeferredDeletionJournal.same(own.getJSONObject("owner"), manual));
  check(restarted.undo("message", own.getString("id")).getString("phase").equals("undone"));
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  restarted.reconcile();
  check(ports.recordDispatched.size() == 2);

  ports.recordOutcomes.put("message", new JSONObject().put("status", "permission-required"));
  ports.recordOutcomes.put("voicemail", new JSONObject().put("status", "conflict"));
  ports.recordOutcomes.put("contact", new JSONObject().put("status", "gone"));
  restarted.stageRecord("message", record("role-lost"), manual, "op_role_lost");
  restarted.stageRecord("voicemail", record("changed"), manual, "op_changed");
  restarted.stageRecord("contact", record("odd"), manual, "op_odd");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  check(!restarted.reconcile());
  check(ports.recordDispatched.size() == 5);
  JSONObject refused = restarted.receipt("message", "op_role_lost");
  check(refused.getString("phase").equals("paused") && refused.getString("blocked").equals("permission-required"));
  check(restarted.receipt("voicemail", "op_changed").getString("phase").equals("conflict"));
  check(restarted.receipt("contact", "op_odd").getString("phase").equals("unknown"));
  check(!restarted.reconcile());
  check(ports.recordDispatched.size() == 5);
  check(restarted.undo("message", "op_role_lost").getString("phase").equals("undone"));
  refuses(IllegalStateException.class, () -> restarted.undo("voicemail", "op_changed"));
  refuses(IllegalStateException.class, () -> restarted.dismiss("voicemail", "op_changed"));
  check(restarted.dismiss("contact", "op_odd").getString("status").equals("acknowledged"));
  check(pendingRow(restarted, "op_odd") == null);
  ports.recordOutcomes.clear();

  ports.recordLost = true;
  restarted.stageRecord("thread", record("lost"), manual, "op_lost_thread");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  restarted.reconcile();
  DeferredDeletionCoordinator afterLoss = coordinator(ports);
  afterLoss.reconcile();
  check(ports.recordDispatched.size() == 6);
  check(afterLoss.receipt("thread", "op_lost_thread").getString("phase").equals("unknown"));
  refuses(IllegalStateException.class, () -> afterLoss.undo("thread", "op_lost_thread"));
  ports.recordLost = false;

  JSONObject agent = afterLoss.agentOwner();
  afterLoss.stageRecord("contact", record("agent"), agent, "op_agent_contact");
  ports.identity.put("enrollmentId", "enrollment-2");
  ports.elapsed += DeletionDeadline.WINDOW_MS;
  afterLoss.reconcile();
  JSONObject foreign = afterLoss.receipt("contact", "op_agent_contact");
  check(foreign.getString("phase").equals("paused") && foreign.getString("blocked").equals("owner-changed"));
  check(ports.recordDispatched.size() == 6);
  ports.identity.put("enrollmentId", "enrollment");
  ports.identity.put("sessionId", "s2");
  refuses(SecurityException.class, () -> afterLoss.stageRecord("message", record("stale"), agent, "op_stale_owner"));
  check(afterLoss.receipt("message", "op_stale_owner") == null);

  Store legacy = new Store();
  DeferredDeletionJournal before = new DeferredDeletionJournal(legacy);
  before.stage("legacy", "calendar", object("owner"), object("event"), new DeletionDeadline("boot", 100, 1000));
  JSONObject stored = new JSONObject(legacy.saved);
  stored.getJSONObject("records").getJSONObject("legacy").remove("kind");
  legacy.saved = stored.toString();
  DeferredDeletionJournal reread = new DeferredDeletionJournal(legacy);
  check(reread.list("boot", 200).getJSONObject(0).getString("kind").equals("calendar"));
  refuses(IllegalArgumentException.class, () -> reread.stage("legacy", "message", object("owner"), object("event"), new DeletionDeadline("boot", 100, 1000)));
  check(reread.stage("legacy", "calendar", object("owner"), object("event"), new DeletionDeadline("boot", 100, 1000)).getString("phase").equals("queued"));
  for (String malformed : new String[] {"", "Message", "sms-thread", "x".repeat(17)})
   refuses(IllegalArgumentException.class, () -> reread.stage("kinds", malformed, object("owner"), object("event"), new DeletionDeadline("boot", 100, 1000)));
  refuses(IllegalArgumentException.class, () -> reread.stage("kinds", null, object("owner"), object("event"), new DeletionDeadline("boot", 100, 1000)));
 }
}

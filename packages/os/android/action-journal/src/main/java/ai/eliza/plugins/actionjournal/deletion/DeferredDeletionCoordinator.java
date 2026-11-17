package ai.eliza.plugins.actionjournal.deletion;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Main-process admission for the reviewed deletion Undo window over Calendar events (this
 * class's journal) and reminders (the host's reminder engine, which suspends delivery as soon as
 * a deletion is staged). Owners are a per-installation manual owner or an authenticated agent
 * owner read through {@link Owners}, never renderer-supplied authority.
 *
 * <ul>
 *   <li>Each row waits {@link DeletionDeadline#WINDOW_MS} on the host's monotonic clock.</li>
 *   <li>Expiry dispatches the provider deletion at most once; an unknown outcome is never replayed.</li>
 *   <li>An owner that changed pauses the row instead of deleting. An unreachable agent owner
 *       leaves it queued for retry, up to {@link #OWNER_RETRY_MS}, then pauses it.</li>
 *   <li>Owner network reads ({@link Owners#identity}) happen before the coordinator lock.</li>
 * </ul>
 *
 * <p>The host supplies storage slots, clock, owner, reminder, calendar and scheduler ports and
 * keeps one instance per process. No Android types: host-tested by javac.
 */
public final class DeferredDeletionCoordinator {
 /** Durable encrypted slots. Writes must commit or throw. */
 public interface Slots { String read(String slot) throws Exception; void write(String slot, String value) throws Exception; }
 /** Monotonic clock; {@code continuity} changes on reboot or when it cannot be proven. */
 public interface Clock { String continuity(); long elapsed(); long wall(); }
 public interface Owners {
  /** Authenticated agent owner identity (may block on the owner route; never called under the lock). */
  JSONObject identity() throws Exception;
  /** Current review fence for that identity. Deterministic, no network. */
  String reviewFence(JSONObject identity) throws Exception;
 }
 /** The host reminder engine's deletion rows. {@code owner} is the serialized owner object. */
 public interface Reminders {
  JSONArray pendingDeletions() throws Exception;
  JSONObject stageDeletion(String id, String owner, JSONObject target, JSONObject clock, JSONObject binding) throws Exception;
  JSONObject settleDeletion(String id, String owner, JSONObject clock, boolean undo) throws Exception;
  void pauseDeletion(String id, String owner, String reason) throws Exception;
  /** The current reminder row, or null. */
  JSONObject reminder(String id) throws Exception;
 }
 /** Calendar provider writes for staged targets. */
 public interface CalendarDeletions {
  /** Null admits the write; otherwise the reason the row pauses. Called only for an admitted owner. */
  String refusal(JSONObject owner, JSONObject target) throws Exception;
  /** Returns {@code {status: deleted|conflict|permission-required|unknown}}. */
  JSONObject dispatch(JSONObject target) throws Exception;
  /** Whether a staged target deletes provider event {@code eventId} in source {@code sourceId}. */
  boolean targets(JSONObject target, long sourceId, long eventId) throws Exception;
 }
 /** Wakes {@link #reconcile} after {@code delayMs}, replacing any earlier wake-up. */
 public interface Scheduler { void schedule(long delayMs); }

 public static final class Configuration {
  public final String journalSlot, installationSlot;
  public Configuration(String journalSlot, String installationSlot) {
   if (journalSlot == null || journalSlot.isEmpty() || installationSlot == null || installationSlot.isEmpty() || journalSlot.equals(installationSlot)) throw new IllegalArgumentException("Deletion slots required");
   this.journalSlot = journalSlot;
   this.installationSlot = installationSlot;
  }
 }

 /** Agent identity fields that must stay equal for the same enrolled owner across sessions. */
 static final String[] STABLE_AGENT_FIELDS = {"subjectUserId", "agentId", "installationId", "enrollmentId", "accountRef", "environment"};
 private static final Set<String> PENDING = new HashSet<>(Arrays.asList("queued", "paused", "unknown", "dispatching"));
 static final long OWNER_CACHE_MS = 5000;
 /** How long an expired agent row waits for an unreachable owner route before it pauses. */
 public static final long OWNER_RETRY_MS = 24L * 60 * 60 * 1000;

 private final Configuration configuration;
 private final Slots slots;
 private final Clock clock;
 private final Owners owners;
 private final Reminders reminders;
 private final CalendarDeletions calendarDeletions;
 private final Scheduler scheduler;
 private final DeferredDeletionJournal calendar;
 /** The last agent owner the route authenticated in this process; lets Undo skip a network read. */
 private volatile JSONObject lastAuthenticatedOwner;

 public DeferredDeletionCoordinator(Configuration configuration, Slots slots, Clock clock, Owners owners, Reminders reminders, CalendarDeletions calendarDeletions, Scheduler scheduler) {
  this.configuration = configuration;
  this.slots = slots;
  this.clock = clock;
  this.owners = owners;
  this.reminders = reminders;
  this.calendarDeletions = calendarDeletions;
  this.scheduler = scheduler;
  calendar = new DeferredDeletionJournal(new DeferredDeletionJournal.Store() {
   public String read() throws Exception { return slots.read(configuration.journalSlot); }
   public void save(String value) throws Exception { slots.write(configuration.journalSlot, value); }
  });
 }

 /** The Calendar deletion journal (for host receipts and instrumentation). */
 public DeferredDeletionJournal calendarJournal() { return calendar; }

 private JSONObject time() throws Exception { return new JSONObject().put("continuity", clock.continuity()).put("elapsed", clock.elapsed()).put("wall", clock.wall()); }

 /** The installation's manual owner, created once. */
 public synchronized JSONObject manualOwner() throws Exception {
  String raw = slots.read(configuration.installationSlot);
  if (raw == null) {
   raw = new JSONObject().put("kind", "manual").put("installationId", UUID.randomUUID().toString()).toString();
   slots.write(configuration.installationSlot, raw);
  }
  return new JSONObject(raw);
 }

 /** The authenticated agent owner with its current review fence. May block on the owner route. */
 public JSONObject agentOwner() throws Exception {
  JSONObject identity = owners.identity();
  JSONObject owner = new JSONObject().put("kind", "agent").put("identity", identity).put("reviewFence", owners.reviewFence(identity));
  lastAuthenticatedOwner = owner;
  return owner;
 }

 private static String ownerKey(JSONObject value) { return value.toString(); }
 private static boolean agentKind(JSONObject owner) { return "agent".equals(owner.optString("kind")); }

 private boolean stageOwnerCurrent(JSONObject owner) throws Exception {
  return "manual".equals(owner.getString("kind")) ? DeferredDeletionJournal.same(owner, manualOwner()) : owner.getString("reviewFence").equals(owners.reviewFence(owner.getJSONObject("identity")));
 }

 /** Deterministic owner precondition of stage, checked before an agent claim is written. No network. */
 public boolean stageAdmissible(JSONObject owner) {
  try { return stageOwnerCurrent(owner); } catch (Exception changed) { return false; }
 }

 public synchronized JSONObject stageCalendar(JSONObject target, JSONObject owner, String operationId) throws Exception {
  if (!stageOwnerCurrent(owner)) throw new SecurityException("Deletion owner changed during review");
  JSONObject time = time();
  String id = operationId == null ? UUID.randomUUID().toString() : operationId;
  JSONObject row = calendar.stage(id, owner, target, new DeletionDeadline(time.getString("continuity"), time.getLong("elapsed"), time.getLong("wall")));
  scheduler.schedule(0);
  return row;
 }

 /** Stages a reminder deletion; the reminder engine suspends its delivery immediately. */
 public synchronized JSONObject stageReminder(JSONObject target, JSONObject owner, String operationId, JSONObject binding) throws Exception {
  if (!stageOwnerCurrent(owner)) throw new SecurityException("Deletion owner changed during review");
  String id = operationId == null ? UUID.randomUUID().toString() : operationId;
  JSONObject row = reminders.stageDeletion(id, ownerKey(owner), target, time(), binding);
  scheduler.schedule(0);
  return row;
 }

 /** The receipt for one operation of {@code kind} ({@code calendar} or {@code reminder}), or null. */
 public JSONObject receipt(String kind, String id) throws Exception {
  JSONObject time = time();
  JSONArray rows = "calendar".equals(kind) ? calendar.list(time.getString("continuity"), time.getLong("elapsed")) : reminders.pendingDeletions();
  for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.getJSONObject(i); if (id.equals(row.getString("id"))) return row; }
  return null;
 }

 /** A pending Undo window is not a deleted event and cannot be overwritten by sync. */
 public synchronized boolean calendarPending(long source, long event) throws Exception {
  JSONObject time = time();
  JSONArray rows = calendar.list(time.getString("continuity"), time.getLong("elapsed"));
  for (int i = 0; i < rows.length(); i++) {
   JSONObject row = rows.getJSONObject(i);
   if (!pendingPhase(row)) continue;
   JSONObject target = row.getJSONObject("target");
   if (!Long.toString(source).equals(target.optString("sourceId"))) continue;
   if (calendarDeletions.targets(target, source, event)) return true;
  }
  return false;
 }

 private static String reminderWindow(JSONObject row, JSONObject time) throws Exception {
  return DeletionDeadline.window(row.getString("continuity"), row.getLong("createdElapsed"), row.getLong("expiresElapsed"), time.getString("continuity"), time.getLong("elapsed"));
 }

 /** Rows the Undo notice shows for the visible owner, each tagged with its {@code kind}. */
 public JSONArray pending() throws Exception { return notice(true, false).getJSONArray("pending"); }

 /** Note links exist for reminders only. A queued/undone/uncertain receipt proves nothing. */
 public JSONArray deletedNoteOrigins() throws Exception { return notice(false, true).getJSONArray("deletedNoteOrigins"); }

 /** {@link #pending} and {@link #deletedNoteOrigins} from one reminder read (the notice poll). */
 public JSONObject pendingWithOrigins() throws Exception { return notice(true, true); }

 private JSONObject notice(boolean withPending, boolean withOrigins) throws Exception {
  JSONArray pending = new JSONArray(), origins = new JSONArray();
  Visibility visibility = new Visibility();
  Set<String> acknowledged = new HashSet<>();
  JSONObject time = time();
  if (withPending) {
   // Reminder acknowledgements live in the same journal, so one read serves both kinds.
   DeferredDeletionJournal.Snapshot snapshot = calendar.snapshot(time.getString("continuity"), time.getLong("elapsed"));
   for (int i = 0; i < snapshot.rows.length(); i++) {
    JSONObject row = snapshot.rows.getJSONObject(i);
    if (pendingPhase(row) && !snapshot.acknowledgements.contains("calendar:" + row.getString("id")) && visibility.visible(row.getJSONObject("owner"))) pending.put(row.put("kind", "calendar"));
   }
   acknowledged = snapshot.acknowledgements;
  }
  JSONArray rows = reminders.pendingDeletions();
  for (int i = 0; i < rows.length(); i++) {
   JSONObject row = rows.getJSONObject(i);
   if (withPending && pendingPhase(row)) {
    if (acknowledged.contains("reminder:" + row.getString("id")) || !visibility.visible(new JSONObject(row.getString("owner")))) continue;
    if ("queued".equals(row.getString("phase"))) row.put("window", reminderWindow(row, time));
    pending.put(row.put("kind", "reminder"));
   } else if (withOrigins && "deleted".equals(row.optString("phase")) && "complete".equals(row.optString("effects")) && visibility.visible(new JSONObject(row.getString("owner")))) {
    String id = row.getJSONObject("target").getString("reminderId");
    JSONObject reminder = reminders.reminder(id);
    if (reminder != null && "cancelled".equals(reminder.optString("status")) && reminder.optString("occurrenceId").equals(row.getJSONObject("target").getString("occurrenceId"))) origins.put(new JSONObject().put("kind", "reminder").put("id", id));
   }
  }
  return new JSONObject().put("pending", pending).put("deletedNoteOrigins", origins);
 }

 /**
  * Owner visibility memoized for one notice call: the manual owner is read at most once and each
  * distinct owner is judged once. Never kept across calls, since a data reset replaces the owner.
  */
 private final class Visibility {
  private final Map<String, Boolean> owners = new HashMap<>();
  private JSONObject manual;
  boolean visible(JSONObject owner) {
   String key = ownerKey(owner);
   Boolean known = owners.get(key);
   if (known != null) return known;
   boolean result;
   if ("manual".equals(owner.optString("kind"))) {
    try { if (manual == null) manual = manualOwner(); result = DeferredDeletionJournal.same(owner, manual); } catch (Exception unavailable) { result = false; }
   } else result = DeferredDeletionCoordinator.this.visible(owner);
   owners.put(key, result);
   return result;
  }
 }

 private static boolean pendingPhase(JSONObject row) { return PENDING.contains(row.optString("phase")); }

 private final Object visibilityLock = new Object();
 private JSONObject visibleOwner;
 private long visibleUntil, visibleFailedUntil;

 static boolean stableOwner(JSONObject a, JSONObject b) throws Exception {
  if (!a.getString("kind").equals(b.getString("kind"))) return false;
  if ("manual".equals(a.getString("kind"))) return DeferredDeletionJournal.same(a, b);
  JSONObject x = a.getJSONObject("identity"), y = b.getJSONObject("identity");
  for (String field : STABLE_AGENT_FIELDS) if (!x.getString(field).equals(y.getString(field))) return false;
  return true;
 }

 /** Returning to the same enrolled owner shows its rows; another owner's rows stay hidden. */
 private boolean visible(JSONObject owner) {
  try {
   if ("manual".equals(owner.getString("kind"))) return stageOwnerCurrent(owner);
   synchronized (visibilityLock) {
    // A failed owner read hides agent rows for the cache period instead of repeating per row.
    if (clock.elapsed() < visibleFailedUntil) return false;
    boolean valid = false;
    try { valid = visibleOwner != null && clock.elapsed() < visibleUntil && stageOwnerCurrent(visibleOwner); } catch (Exception changed) {}
    if (!valid) {
     visibleOwner = null;
     JSONObject authenticated;
     try { authenticated = agentOwner(); }
     catch (Exception unavailable) { visibleFailedUntil = clock.elapsed() + OWNER_CACHE_MS; return false; }
     visibleFailedUntil = 0;
     visibleUntil = clock.elapsed() + OWNER_CACHE_MS;
     visibleOwner = authenticated;
    }
    return stableOwner(owner, visibleOwner);
   }
  } catch (Exception unavailable) { return false; }
 }

 private JSONObject agentOwnerOrNull() { try { return agentOwner(); } catch (Exception unavailable) { return null; } }

 private static JSONObject rowOwner(String kind, JSONObject row) throws Exception { return "calendar".equals(kind) ? row.getJSONObject("owner") : new JSONObject(row.getString("owner")); }

 private JSONObject agentOwnerFor(String kind, String id) {
  try {
   JSONObject row = receipt(kind, id);
   if (row == null || !agentKind(rowOwner(kind, row))) return null;
   JSONObject cached = lastAuthenticatedOwner;
   return cached != null && stableOwner(rowOwner(kind, row), cached) ? cached : agentOwnerOrNull();
  } catch (Exception unavailable) { return null; }
 }

 /**
  * An expired agent row whose owner route could not be read stays queued and retries with backoff,
  * up to {@link #OWNER_RETRY_MS} past its window; after that it pauses as owner-unavailable.
  */
 private static boolean awaitingOwner(JSONObject owner, JSONObject agent, long expiresElapsed, long elapsed) {
  return agentKind(owner) && agent == null && elapsed - expiresElapsed < OWNER_RETRY_MS;
 }

 /** Exact owner match against an owner resolved outside the lock. An unavailable agent owner throws (owner-unavailable). */
 private boolean admitted(JSONObject owner, JSONObject agent) throws Exception {
  if (!agentKind(owner)) return DeferredDeletionJournal.same(owner, manualOwner());
  if (agent == null) throw new SecurityException("Deletion owner unavailable");
  return DeferredDeletionJournal.same(owner, agent) && stageOwnerCurrent(owner);
 }

 private boolean undoAllowed(JSONObject owner, JSONObject agent) throws Exception {
  return agentKind(owner) ? agent != null && stableOwner(owner, agent) : stableOwner(owner, manualOwner());
 }

 /** Hides an uncertain outcome's notice. Its receipt and no-replay state are retained. */
 public JSONObject dismiss(String kind, String id) throws Exception {
  if (!"calendar".equals(kind) && !"reminder".equals(kind)) throw new IllegalArgumentException("Unknown deletion kind");
  JSONObject agent = agentOwnerFor(kind, id);
  synchronized (this) {
   JSONObject row = receipt(kind, id);
   if (row == null) throw new IllegalArgumentException("Deletion receipt unavailable");
   if (!undoAllowed(rowOwner(kind, row), agent)) throw new SecurityException("Deletion owner changed");
   String phase = row.getString("phase");
   if (!"unknown".equals(phase) && !"dispatching".equals(phase)) throw new IllegalStateException("Only uncertain outcomes can be dismissed");
   calendar.acknowledge(kind, id);
   return new JSONObject().put("status", "acknowledged");
  }
 }

 /**
  * Keeps the item while the window is open or paused. A settled deletion is refused, never
  * reported as kept. The window is judged at the tap's arrival, before any owner read; an owner
  * authenticated earlier in this process is enough because Undo only keeps data.
  */
 public JSONObject undo(String kind, String id) throws Exception {
  JSONObject time = time();
  JSONObject agent = agentOwnerFor(kind, id);
  synchronized (this) {
   if ("calendar".equals(kind)) {
    JSONArray rows = calendar.list(time.getString("continuity"), time.getLong("elapsed"));
    for (int i = 0; i < rows.length(); i++) {
     JSONObject row = rows.getJSONObject(i);
     if (id.equals(row.getString("id")) && undoAllowed(row.getJSONObject("owner"), agent)) return calendar.undo(id, row.getJSONObject("owner"), time.getString("continuity"), time.getLong("elapsed"));
    }
   } else if ("reminder".equals(kind)) {
    JSONArray rows = reminders.pendingDeletions();
    for (int i = 0; i < rows.length(); i++) {
     JSONObject row = rows.getJSONObject(i);
     if (id.equals(row.getString("id")) && undoAllowed(new JSONObject(row.getString("owner")), agent)) return DeferredDeletionJournal.requireUndone(reminders.settleDeletion(id, row.getString("owner"), time, true));
    }
   }
   throw new SecurityException("Deletion no longer belongs to this session");
  }
 }

 /** Whether any row the next reconcile acts on is agent-owned, so the owner route must be read first. */
 private boolean reconcileNeedsAgent() throws Exception {
  JSONObject time = time();
  JSONArray events = calendar.list(time.getString("continuity"), time.getLong("elapsed"));
  for (int i = 0; i < events.length(); i++) { JSONObject row = events.getJSONObject(i); if ("queued".equals(row.optString("phase")) && agentKind(row.getJSONObject("owner"))) return true; }
  JSONArray rows = reminders.pendingDeletions();
  for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.getJSONObject(i); if (("queued".equals(row.optString("phase")) || "pending".equals(row.optString("effects"))) && agentKind(new JSONObject(row.getString("owner")))) return true; }
  return false;
 }

 /**
  * Settles expired windows. Every row is isolated: one row's failure never stops later rows or the
  * next wake-up from being scheduled. An agent owner that cannot be read is retried, never admitted.
  * Returns true when a row failed and the host should retry with backoff (local settlement and
  * idempotent effects only; a claimed dispatch is never retried).
  */
 public boolean reconcile() throws Exception {
  JSONObject agent = reconcileNeedsAgent() ? agentOwnerOrNull() : null;
  synchronized (this) {
   JSONObject time = time();
   long elapsed = time.getLong("elapsed");
   long next = Long.MAX_VALUE;
   boolean failed = false;
   String continuity = time.getString("continuity");
   try {
    JSONArray events = calendar.list(continuity, elapsed);
    for (int i = 0; i < events.length(); i++) {
     try {
      JSONObject row = events.getJSONObject(i);
      if (!"queued".equals(row.getString("phase"))) continue;
      if ("open".equals(row.getString("window"))) next = Math.min(next, row.getJSONObject("deadline").getLong("expiresElapsed") - elapsed);
      else if ("expired".equals(row.getString("window"))) {
       if (awaitingOwner(row.getJSONObject("owner"), agent, row.getJSONObject("deadline").getLong("expiresElapsed"), elapsed)) { failed = true; continue; }
       calendar.expire(row.getString("id"), continuity, elapsed, (owner, target) -> admitted(owner, agent) ? calendarDeletions.refusal(owner, target) : "owner-changed", calendarDeletions::dispatch);
      }
     } catch (Exception rowFailed) { failed = true; }
    }
    JSONArray rows = reminders.pendingDeletions();
    for (int i = 0; i < rows.length(); i++) {
     try {
      JSONObject row = rows.getJSONObject(i);
      String phase = row.getString("phase");
      if (!"queued".equals(phase)) {
       if (!"pending".equals(row.optString("effects"))) continue;
       // Settled effects are local and idempotent: a rotated session or review fence of the
       // same enrolled owner must not strand them. An unavailable owner retries with backoff.
       JSONObject owner = new JSONObject(row.getString("owner"));
       if (agentKind(owner) && agent == null) { failed = true; continue; }
       if (stableOwner(owner, agentKind(owner) ? agent : manualOwner())) reminders.settleDeletion(row.getString("id"), row.getString("owner"), time, "undone".equals(phase));
       continue;
      }
      if (!continuity.equals(row.getString("continuity")) || elapsed < row.getLong("createdElapsed")) continue;
      if (elapsed < row.getLong("expiresElapsed")) { next = Math.min(next, row.getLong("expiresElapsed") - elapsed); continue; }
      JSONObject owner = new JSONObject(row.getString("owner"));
      if (awaitingOwner(owner, agent, row.getLong("expiresElapsed"), elapsed)) { failed = true; continue; }
      if (agentKind(owner) && agent == null) reminders.pauseDeletion(row.getString("id"), row.getString("owner"), "owner-unavailable");
      else if (admitted(owner, agent)) reminders.settleDeletion(row.getString("id"), row.getString("owner"), time, false);
      else reminders.pauseDeletion(row.getString("id"), row.getString("owner"), "owner-changed");
     } catch (Exception rowFailed) { failed = true; }
    }
   } catch (Exception listFailed) { failed = true; }
   finally { if (next != Long.MAX_VALUE) scheduler.schedule(Math.max(1, next)); }
   return failed;
  }
 }

 /** Schedules an immediate reconcile (process start, plugin load). */
 public void start() { scheduler.schedule(0); }
}

package ai.eliza.plugins.actionjournal;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Capacitor bridge over {@link ActionJournal}. Hosts extend this class with a public no-argument
 * constructor, annotate the subclass with their chosen {@code @CapacitorPlugin} name and return
 * their configured journal from {@link #journal()}. Every call runs on one serial worker; the
 * journal never runs on the UI thread. Subclasses add host-specific recoveries with
 * {@link #work}. This bridge performs no device action and grants no approval.
 */
public abstract class ActionJournalPlugin extends Plugin {
 /** Host work on the journal. Runs on the serial worker; the result resolves the call. */
 protected interface Task { JSObject run(ActionJournal journal, String scope, String proposalId) throws Exception; }

 private final ExecutorService worker = Executors.newSingleThreadExecutor();
 private volatile boolean destroyed;
 private ActionJournal journal;

 /**
  * Returns the host's journal. Called on the worker thread after the bridge is available.
  * Every bridge in one process (for example a main and an assistant Activity) must receive the
  * same instance for the same storage, so that one monitor serializes all transitions.
  */
 protected abstract ActionJournal createJournal() throws Exception;

 protected final synchronized ActionJournal journal() throws Exception {
  if (journal == null) journal = createJournal();
  return journal;
 }
 protected final ExecutorService worker() { return worker; }
 protected final boolean destroyed() { return destroyed; }
 /** The rejection text every refused or failed journal call uses. */
 protected String refusal() { return "Action journal unavailable or transition rejected"; }

 /** Runs {@code task} on the worker with a validated scope and, when required, proposal id. */
 protected final void work(PluginCall call, boolean needsId, Task task) {
  try {
   worker.execute(() -> {
    try {
     if (destroyed) throw new IllegalStateException("Destroyed");
     String scope = ActionJournal.scope(call.getString("scope"));
     String id = needsId ? ActionJournal.id(call.getString("proposalId")) : null;
     call.resolve(task.run(journal(), scope, id));
    } catch (Exception error) { call.reject(refusal()); }
   });
  } catch (RejectedExecutionException retired) { call.reject(refusal()); }
 }

 public static JSObject entryResponse(JSONObject entry) throws Exception {
  JSObject value = new JSObject();
  value.put("entry", entry == null ? JSONObject.NULL : entry);
  return value;
 }

 @PluginMethod public void reserve(PluginCall call) {
  work(call, true, (journal, scope, id) -> {
   ActionJournal.Reservation reservation = journal.reserve(scope, id, call.getString("operationId"), call.getString("operationHash"), call.getObject("record"));
   JSObject value = entryResponse(reservation.entry);
   value.put("created", reservation.created);
   return value;
  });
 }
 @PluginMethod public void markApplying(PluginCall call) {
  work(call, true, (journal, scope, id) -> entryResponse(journal.markApplying(scope, id, call.getString("attemptId"))));
 }
 @PluginMethod public void finish(PluginCall call) {
  work(call, true, (journal, scope, id) -> entryResponse(journal.finish(scope, id, call.getString("status"), call.getString("summary"), call.getObject("result"))));
 }
 @PluginMethod public void get(PluginCall call) {
  work(call, true, (journal, scope, id) -> entryResponse(journal.get(scope, id)));
 }
 @PluginMethod public void list(PluginCall call) {
  work(call, false, (journal, scope, id) -> {
   JSONArray listed = journal.list(scope);
   JSArray entries = new JSArray();
   for (int i = 0; i < listed.length(); i++) entries.put(listed.get(i));
   JSObject value = new JSObject();
   value.put("entries", entries);
   return value;
  });
 }

 /** Subclasses overriding this must call super. Queued calls reject after destruction. */
 @Override protected void handleOnDestroy() {
  destroyed = true;
  worker.shutdown();
  super.handleOnDestroy();
 }
}

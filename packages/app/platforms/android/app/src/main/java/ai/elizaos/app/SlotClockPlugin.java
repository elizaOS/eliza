package ai.elizaos.app;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import android.content.Intent;
import android.app.AlertDialog;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native Clock adapter. Credentials never cross this bridge; definition changes require an Activity gesture.
 * Authenticated current ringing Stop/Snooze use scoped immediate policy and the durable journal.
 * Cost: two bounded network workers, no polling. Owner enrollment/context is cached per native snapshot.
 * Review reads pending proposals; a gesture rechecks context/proposal, decides and claims. Confirm rechecks
 * context/proposal before one journal-controlled Activity launch, then posts the persisted outcome.
 */
@CapacitorPlugin(name = "SlotClock")
public final class SlotClockPlugin extends Plugin {
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(16), runnable -> { Thread thread = new Thread(runnable, "eliza-clock-host"); thread.setDaemon(true); return thread; });
    private NativeSecureStore store;
    private volatile Session active;
    private final java.util.Set<String> retiredScopes = ConcurrentHashMap.newKeySet();
    private final ClockAgentRequests agentRequests = new ClockAgentRequests(System::currentTimeMillis, 64);
    private final Map<PluginCall, ClockAgentRequests.Entry> queuedAgentCalls = new ConcurrentHashMap<>();
    private volatile boolean foreground = true;
    private final ClockOwnerRetirement retirement = new ClockOwnerRetirement();
    private AlertDialog localAlarmDialog;
    private PluginCall localAlarmCall;
    private final Runnable alarmChanged = () -> notifyListeners("proposalsChanged", new JSObject());
    private interface Work { void run(Session session) throws Exception; }
    private final class Session {
        final ClockHostClient client;
        final JSONObject context;
        final String scope, owner;
        final Map<String, ClockConsentCoordinator.ApprovedEntry> admitted = new ConcurrentHashMap<>();
        final Map<String, ClockHostClient.Proposal> claims = new ConcurrentHashMap<>();
        final ClockConsentCoordinator coordinator;
        ClockReviewDialog dialog;
        Session(ClockHostClient client, JSONObject context) throws Exception {
            this.client = client; this.context = context; scope = ClockHostClient.text(context, "scope"); owner = client.owner(context);
            ClockOwnedAlarms.remember(getContext(), client, context);
            coordinator = ClockReviewDialog.coordinator(getActivity(), owner, identity -> {
                // No credential-lock acquisition under the journal lock: confirmation fences the
                // entire dispatch with withSnapshot, and stale preparation can never launch.
                checkOwner();
                ClockConsentCoordinator.ApprovedEntry entry = admitted.get(identity.proposalId);
                if (entry == null || !scope.equals(identity.scope) || !identity.proposalId.equals(identity.operationId))
                    throw new SecurityException("Native Clock claim unavailable");
                return entry;
            });
        }
        void check() throws Exception {
            checkOwner();
            client.current();
        }
        void checkOwner() {
            if (active != this || !foreground || retirement.isBlocked()) throw new SecurityException("Native Clock foreground owner retired");
        }
        void openDialog() {
            dialog = new ClockReviewDialog(getActivity(), coordinator, new ClockReviewDialog.OwnerFence() {
                @Override public void assertCurrent() {
                    try { check(); } catch (Exception error) { throw new SecurityException("Native Clock owner changed", error); }
                }
                @Override public void retirementFailed(Exception error) { retirement.failed(); }
            }, (identity, request, consent) -> {
                check();
                ClockHostClient.Proposal proposal = claims.get(identity.proposalId);
                if (proposal == null || !ClockHostClient.sameRequest(proposal.request, request))
                    throw new SecurityException("Owned alarm claim unavailable");
                return ClockOwnedAlarms.execute(getActivity(), ClockOwnedAlarms.owner(getContext(), client), identity,
                        request, alarmRevision(proposal.raw.getJSONObject("payload"), "clockContextRevision"), consent);
            });
        }
        void admit(ClockHostClient.Proposal proposal) throws Exception {
            check(); admitted.put(proposal.id, ClockHostClient.admitted(context, proposal, owner)); claims.put(proposal.id, proposal);
        }
    }
    @Override public void load() {
        store = new NativeSecureStore(getContext());
        ElizaAlarmRingingService.observe(alarmChanged);
        refreshAlarmPermission();
    }

    private boolean supported() {
        return getContext().getSystemService(android.content.Context.ALARM_SERVICE) instanceof android.app.AlarmManager;
    }
    private void enqueue(PluginCall call, Runnable operation) {
        try { workers.execute(operation); }
        catch (java.util.concurrent.RejectedExecutionException error) {
            // error-policy:J1 bounded admission rejects rather than expanding work or silently dropping calls.
            finishAgent(call); call.reject("Native Clock worker unavailable");
        }
    }
    private void withSession(PluginCall call, Work work) {
        enqueue(call, () -> {
            try {
                if (retirement.isBlocked() || !foreground || !supported()) throw new SecurityException("Native Clock unavailable");
                Session session = active;
                if (session != null) {
                    try { session.check(); }
                    catch (Exception stale) {
                        if ("requestAgent".equals(call.getMethodName())) { reject(call); return; }
                        // error-policy:J2 retirement must settle before admitting another native profile.
                        getActivity().runOnUiThread(() -> { retire(); if (!retirement.isBlocked()) withSession(call, work); else call.reject("Native Clock retirement failed"); });
                        return;
                    }
                    work.run(session); return;
                }
                if ("requestAgent".equals(call.getMethodName())) throw new SecurityException("Native chat owner retired before admission");
                store.ensureClockDevice();
                ClockHostClient client = new ClockHostClient(store, store.snapshot(), url -> CookieManager.getInstance().getCookie(url),
                        ZoneId.systemDefault().getId(), new ClockHostClient.AlarmMetadata() {
                            @Override public JSONObject context(ClockHostClient selected) throws Exception {
                                return ClockOwnedAlarms.metadata(getContext(), selected);
                            }
                            @Override public void rejected(ClockHostClient selected) { ClockOwnedAlarms.revoke(getContext(), selected); }
                        });
                if ("requestAgent".equals(call.getMethodName())) expectedOrigin(call, client);
                JSONObject context = client.context(true);
                getActivity().runOnUiThread(() -> {
                    try {
                        client.current();
                        if (!foreground || retirement.isBlocked()) throw new SecurityException("Native Clock retired during enrollment");
                        if (active == null) {
                            active = new Session(client, context); active.openDialog();
                            notifyListeners("proposalsChanged", new JSObject());
                        }
                        withSession(call, work);
                    } catch (Exception error) {
                        // error-policy:J1 no credential or raw HTTP diagnostic reaches JavaScript.
                        reject(call);
                    }
                });
            } catch (Exception error) {
                // error-policy:J1 authenticated network failures stay explicit and carry no secret-bearing diagnostics.
                reject(call);
            }
        });
    }
    private void reject(PluginCall call) {
        finishAgent(call);
        if ("getStatus".equals(call.getMethodName())) {
            JSObject status = new JSObject(); status.put("supported", false); status.put("reason", "Native Clock authentication, handler, or foreground unavailable");
            status.put("capabilities", new JSONArray()); status.put("scope", JSONObject.NULL); status.put("installationId", JSONObject.NULL); status.put("context", JSONObject.NULL);
            status.put("agentBase", JSONObject.NULL);
            call.resolve(status);
        } else call.reject("Native Clock request rejected or owner changed");
    }
    @PluginMethod public void getStatus(PluginCall call) {
        withSession(call, session -> {
            session.check();
            JSONObject value = new JSONObject().put("supported", true).put("reason", JSONObject.NULL)
                    .put("capabilities", new JSONArray(session.client.capabilities().split(",")))
                    .put("scope", session.scope).put("installationId", session.client.device.getInstallationId()).put("context", session.client.metadataContext());
            value.put("agentBase", session.client.base.toString().replaceAll("/+$", ""));
            call.resolve(js(value));
        });
    }
    @PluginMethod public void listProposals(PluginCall call) {
        withSession(call, session -> {
            session.client.sameContext(session.context);
            JSONArray proposals = new JSONArray();
            for (ClockHostClient.Proposal proposal : session.client.proposals(session.context)) proposals.put(proposal.summary());
            session.check(); call.resolve(js(new JSONObject().put("scope", session.scope).put("proposals", proposals)));
        });
    }
    private static ClockConsentCoordinator.Identity identity(PluginCall call) throws Exception {
        JSONObject data = call.getData();
        String id = ClockHostClient.identifier(ClockHostClient.text(data, "proposalId"));
        if (!id.equals(ClockHostClient.text(data, "operationId"))) throw new SecurityException("Clock operation identity changed");
        return new ClockConsentCoordinator.Identity(ClockHostClient.digest(ClockHostClient.text(data, "scope")), id, id);
    }
    @PluginMethod public void reviewClock(PluginCall call) {
        withSession(call, session -> {
            ClockConsentCoordinator.Identity identity = identity(call);
            if (!session.scope.equals(identity.scope)) throw new SecurityException("Clock scope changed");
            ClockHandoff.Request requested = ClockHostClient.decode(call.getData().getJSONObject("operation"));
            session.client.sameContext(session.context);
            ClockHostClient.Proposal proposal = session.client.require(session.context, identity.proposalId);
            if (!ClockHostClient.sameRequest(requested, proposal.request)) throw new SecurityException("Clock operation changed");
            if (!"pending".equals(proposal.state) && !"approved".equals(proposal.state)) {
                session.admit(proposal);
                // This read cannot create consent for a previously claimed server operation.
                ClockConsentCoordinator.Review existing = session.coordinator.reconcileClock(identity, requested);
                getActivity().runOnUiThread(() -> {
                    if (existing.result != null) postReceipt(call, session, proposal, identity, existing.result);
                    else session.dialog.reviewClock(identity, requested, callback(call, proposal.request));
                });
                return;
            }
            if (ClockOwnedAlarms.isRingingControl(requested)) {
                controlAgentAlarm(call, session, identity, proposal);
                return;
            }
            ClockHostClient.requiresDecision(session.context, proposal);
            getActivity().runOnUiThread(() -> {
                try {
                    session.check();
                    String scope = requested.owned ? "Managed by Eliza on this phone." + targetDescription(session.client, requested)
                            : "Agent: " + ClockHostClient.text(session.context, "agentId") + "\nOwner: "
                            + ClockHostClient.text(session.context, "subjectUserId") + "\nDevice enrollment: "
                            + ClockHostClient.text(session.context, "enrollmentId") + "\nScope: " + session.scope;
                    session.dialog.reviewPending(identity, requested, scope, completion -> enqueue(call, () -> {
                        try {
                            session.check(); session.client.sameContext(session.context);
                            ClockHostClient.Proposal fresh = session.client.require(session.context, proposal.id);
                            ClockHostClient.sameProposal(proposal, fresh);
                            session.check();
                            ClockHostClient.Proposal approved = ClockHostClient.requiresDecision(session.context, fresh)
                                    ? session.client.transition(session.context, fresh, "decision", new JSONObject().put("digest", fresh.digest).put("decision", "approve"))
                                    : fresh;
                            session.check(); session.client.sameContext(session.context);
                            if (ClockHostClient.requiresDecision(session.context, approved)) throw new SecurityException("Clock approval unavailable");
                            ClockHostClient.Proposal claimed = session.client.transition(session.context, approved, "claim", new JSONObject().put("digest", fresh.digest));
                            session.check(); session.client.sameContext(session.context); session.admit(claimed); completion.ready();
                        } catch (Exception error) {
                            // error-policy:J1 asynchronous claims cannot turn lost responses into fresh consent.
                            completion.failed(error);
                        }
                    }), callback(call, requested));
                } catch (Exception error) { reject(call); }
            });
        });
    }
    private void controlAgentAlarm(PluginCall call, Session session, ClockConsentCoordinator.Identity identity,
                                   ClockHostClient.Proposal proposal) throws Exception {
        long revision = alarmRevision(proposal.raw.getJSONObject("payload"), "clockContextRevision");
        String owner = ClockOwnedAlarms.owner(getContext(), session.client);
        store.withSnapshot(session.client.snapshot, () -> {
            session.check(); ClockOwnedAlarms.requireActive(getContext(), owner, proposal.request, revision); return null;
        });
        session.client.sameContext(session.context);
        ClockHostClient.Proposal fresh = session.client.require(session.context, proposal.id);
        ClockHostClient.sameProposal(proposal, fresh);
        ClockHostClient.Proposal approved = ClockHostClient.requiresDecision(session.context, fresh)
                ? session.client.transition(session.context, fresh, "decision", new JSONObject().put("digest", fresh.digest).put("decision", "approve")) : fresh;
        session.check(); session.client.sameContext(session.context);
        ClockHostClient.Proposal claimed = session.client.transition(session.context, approved, "claim", new JSONObject().put("digest", fresh.digest));
        session.check(); session.client.sameContext(session.context); session.admit(claimed);
        getActivity().runOnUiThread(() -> {
            try {
                session.check();
                ClockConsentCoordinator.Result result = store.withSnapshot(session.client.snapshot, () -> {
                    session.check();
                    return session.coordinator.controlActiveAlarm(identity, claimed.request, new ClockConsentCoordinator.Dispatcher() {
                        private String receipt;
                        @Override public ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consume) {
                            try {
                                session.check();
                                if (!Instant.parse(claimed.expiresAt).isAfter(Instant.now())) throw new SecurityException("Ringing control claim expired");
                                if (!owner.equals(ClockOwnedAlarms.owner(getContext(), session.client))) throw new SecurityException("Ringing owner changed");
                                ClockHandoff.Effect effect = ClockOwnedAlarms.execute(getActivity(), owner, identity, request, revision, consume);
                                receipt = effect.receipt; return effect.outcome;
                            } catch (RuntimeException error) { throw error; }
                            catch (Exception error) { throw new IllegalStateException("Ringing control failed", error); }
                        }
                        @Override public String receipt() { return receipt; }
                    });
                });
                postReceipt(call, session, claimed, identity, result);
            } catch (Exception error) { reject(call); }
        });
    }

    private ClockReviewDialog.Callback callback(PluginCall call, ClockHandoff.Request request) {
        return new ClockReviewDialog.Callback() {
            @Override public void completed(ClockConsentCoordinator.Result result, String token) { complete(call, request, result, token); }
            @Override public void failed(Exception error) { reject(call); }
        };
    }
    private static void complete(PluginCall call, ClockHandoff.Request request, ClockConsentCoordinator.Result outcome, String token) {
        complete(call, request, outcome, token, null, null);
    }
    private static void complete(PluginCall call, ClockHandoff.Request request, ClockConsentCoordinator.Result outcome, String token,
                                 String effectReceipt, String operationId) {
        try {
            JSONObject reply = new JSONObject();
            if (outcome != null) reply.put("result", ClockHostReceipts.result(request, outcome, effectReceipt, operationId)).put("receiptPending", false);
            if (token != null) reply.put("reviewToken", token);
            call.resolve(js(reply));
        } catch (Exception error) { call.reject("Native Clock response unavailable"); }
    }
    @PluginMethod public void confirmClock(PluginCall call) {
        withSession(call, session -> {
            ClockConsentCoordinator.Identity identity = identity(call);
            if (!session.scope.equals(identity.scope)) throw new SecurityException("Clock scope changed");
            String token = ClockHostClient.text(call.getData(), "reviewToken");
            session.client.sameContext(session.context);
            ClockHostClient.Proposal proposal = session.client.require(session.context, identity.proposalId);
            session.admit(proposal);
            getActivity().runOnUiThread(() -> {
                try {
                    session.check();
                    store.withSnapshot(session.client.snapshot, () -> {
                        session.check();
                        session.dialog.confirmClock(identity, token, new ClockReviewDialog.Callback() {
                            @Override public void completed(ClockConsentCoordinator.Result outcome, String ignored) {
                                postReceipt(call, session, proposal, identity, outcome);
                            }
                            @Override public void failed(Exception error) { reject(call); }
                        }, () -> {
                            if (!Instant.parse(proposal.expiresAt).isAfter(Instant.now())) throw new SecurityException("Clock execution claim expired");
                        });
                        return null;
                    });
                } catch (Exception error) { reject(call); }
            });
        });
    }
    private void postReceipt(PluginCall call, Session session, ClockHostClient.Proposal proposal,
                             ClockConsentCoordinator.Identity identity, ClockConsentCoordinator.Result outcome) {
        final String nativeReceipt;
        try {
            // Capture the bound, committed receipt while native effect authority is current.
            // Its authenticated publication may finish after this Activity retires.
            nativeReceipt = outcome == ClockConsentCoordinator.Result.APPLIED ? session.coordinator.effectReceipt(identity) : null;
        } catch (Exception error) { call.reject("Saved native alarm receipt could not be verified"); return; }
        enqueue(call, () -> {
            try {
                // Activity pause ends effect authority, but authenticated publication of an already
                // persisted native receipt may finish while the external Clock is foreground.
                session.client.current(); session.client.sameContext(session.context);
                ClockHostClient.Proposal fresh = session.client.require(session.context, proposal.id);
                ClockHostClient.sameProposal(proposal, fresh);
                if (proposal.attemptId == null || !proposal.attemptId.equals(fresh.attemptId)) throw new SecurityException("Clock receipt attempt changed");
                session.client.transition(session.context, fresh, "receipt", ClockHostReceipts.body(fresh, identity, outcome, nativeReceipt));
                complete(call, proposal.request, outcome, null, nativeReceipt, identity.operationId);
                notifyListeners("proposalsChanged", new JSObject());
            } catch (Exception error) {
                // error-policy:J2 the journal governs retries: a lost HTTP acknowledgement never redispatches.
                try { call.resolve(js(new JSONObject().put("result", ClockHostReceipts.result(proposal.request, outcome,
                        nativeReceipt,
                        identity.operationId)).put("receiptPending", true))); }
                catch (Exception encoding) { call.reject("Persisted native Clock receipt unavailable"); }
            }
        });
    }
    private static long alarmRevision(JSONObject value, String field) throws Exception {
        Object raw = value.get(field);
        if (!(raw instanceof Integer || raw instanceof Long)) throw new IllegalArgumentException("Invalid native alarm revision");
        long revision = ((Number) raw).longValue();
        if (revision < 0 || revision > 9007199254740991L) throw new IllegalArgumentException("Invalid native alarm revision");
        return revision;
    }
    private ClockHostClient localClient() throws Exception {
        return new ClockHostClient(store, store.snapshot(), url -> CookieManager.getInstance().getCookie(url), ZoneId.systemDefault().getId());
    }
    private String targetDescription(ClockHostClient client, ClockHandoff.Request request) throws Exception {
        if (request.alarmId == null) return "";
        ElizaAlarms.Alarm alarm = ElizaAlarms.find(getContext(), request.alarmId, ClockOwnedAlarms.owner(getContext(), client));
        return String.format(java.util.Locale.ROOT, "\n\nSelected alarm: %s\nTime: %02d:%02d\nRepeat: %s\nState: %s",
                alarm.label.isEmpty() ? "Alarm" : alarm.label, alarm.hour, alarm.minute,
                ClockReviewDialog.repeatDescription(alarm.days), alarm.enabled ? "Enabled" : "Disabled");
    }
    @PluginMethod public void getAlarmStatus(PluginCall call) {
        enqueue(call, () -> {
            try {
                ClockHostClient client = localClient();
                JSONObject state = store.withSnapshot(client.snapshot, () -> ClockOwnedAlarms.status(getContext(), client));
                client.current(); call.resolve(js(state));
            } catch (SecurityException error) {
                // error-policy:J1 an unverified owner is unavailable, never an empty alarm inventory.
                try { call.resolve(js(ClockOwnedAlarms.unavailable(getContext()))); }
                catch (Exception unavailable) { call.reject("Native alarm owner could not be checked"); }
            } catch (Exception error) { call.reject("Native alarm inventory could not be read"); }
        });
    }
    @PluginMethod public void manageAlarm(PluginCall call) {
        enqueue(call, () -> {
            try {
                ClockHostClient.exact(call.getData(), "operation", "alarmsRevision", "expectedOwner");
                ClockHandoff.Request request = ClockHostClient.decode(call.getData().getJSONObject("operation"));
                if (!request.owned || request.action == ClockHandoff.Action.SHOW)
                    throw new IllegalArgumentException("Local alarm operation unavailable");
                long revision = alarmRevision(call.getData(), "alarmsRevision");
                ClockHostClient client = localClient();
                String owner = ClockOwnedAlarms.owner(getContext(), client);
                if (!owner.equals(ClockHostClient.digest(ClockHostClient.text(call.getData(), "expectedOwner"))))
                    throw new SecurityException("Alarm inventory owner changed");
                String id = java.util.UUID.randomUUID().toString();
                ClockConsentCoordinator.Identity identity = new ClockConsentCoordinator.Identity(owner, id, id);
                String description = ClockReviewDialog.description(request) + targetDescription(client, request);
                client.current();
                store.withSnapshot(client.snapshot, () -> ElizaAlarms.withRevision(getContext(), revision, () -> null));
                getActivity().runOnUiThread(() -> {
                    try {
                        if (!foreground || localAlarmCall != null) throw new SecurityException("Another alarm review is active");
                        client.current();
                        if (!owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                            throw new SecurityException("Alarm inventory owner changed");
                        if (ClockOwnedAlarms.isRingingControl(request)) {
                            // Local authority is the authenticated owner; identity and exact request
                            // are separately bound in the journal, without a server claim or gesture.
                            ClockConsentCoordinator local = ClockReviewDialog.coordinator(getActivity(), owner, selected -> {
                                try {
                                    if (!foreground || !owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                                        throw new SecurityException("Ringing owner changed");
                                    return new ClockConsentCoordinator.ApprovedEntry(identity, request, owner, owner);
                                } catch (RuntimeException error) { throw error; }
                                catch (Exception error) { throw new SecurityException("Ringing owner changed", error); }
                            });
                            ClockConsentCoordinator.Result result = store.withSnapshot(client.snapshot, () ->
                                local.controlActiveAlarm(identity, request, new ClockConsentCoordinator.Dispatcher() {
                                    private String receipt;
                                    @Override public ClockHandoff.Outcome dispatch(ClockHandoff.Request selected, ClockHandoff.ApprovedConsent consume) {
                                        try {
                                            if (!foreground || !owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                                                throw new SecurityException("Ringing owner changed");
                                            ClockHandoff.Effect effect = ClockOwnedAlarms.execute(getActivity(), owner, identity, selected, revision, consume);
                                            receipt = effect.receipt; return effect.outcome;
                                        } catch (RuntimeException error) { throw error; }
                                        catch (Exception error) { throw new IllegalStateException("Local ringing control failed", error); }
                                    }
                                    @Override public String receipt() { return receipt; }
                                }));
                            call.resolve(js(new JSONObject().put("result", ClockHostReceipts.result(request, result, local.effectReceipt(identity), id))
                                    .put("alarmsRevision", ElizaAlarms.revision(getContext()))));
                            notifyListeners("proposalsChanged", new JSObject());
                            return;
                        }
                        localAlarmCall = call;
                        localAlarmDialog = new AlertDialog.Builder(getActivity()).setTitle("Review alarm").setMessage(description)
                                .setPositiveButton(ClockReviewDialog.positiveLabel(request), (dialog, which) -> {
                                    if (localAlarmCall != call) return;
                                    localAlarmCall = null; localAlarmDialog = null;
                                    boolean[] consumed = {false};
                                    try {
                                        if (!foreground) throw new SecurityException("Alarm owner is not foreground");
                                        client.current();
                                        ClockHandoff.Effect effect = store.withSnapshot(client.snapshot, () -> {
                                            if (!owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                                                throw new SecurityException("Reviewed alarm owner changed");
                                            return ClockOwnedAlarms.execute(getActivity(), owner, identity,
                                                        request, revision, reviewed -> {
                                                            if (consumed[0] || !foreground || !ClockHostClient.sameRequest(request, reviewed))
                                                                throw new SecurityException("Native alarm consent changed");
                                                            try {
                                                                if (!owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                                                                    throw new SecurityException("Native alarm owner changed");
                                                            }
                                                            catch (Exception changed) { throw new SecurityException("Native alarm owner changed", changed); }
                                                            consumed[0] = true;
                                                        });
                                        });
                                        client.current();
                                        ClockConsentCoordinator.Result outcome = effect.outcome == ClockHandoff.Outcome.APPLIED
                                                ? ClockConsentCoordinator.Result.APPLIED : ClockConsentCoordinator.Result.UNAVAILABLE;
                                        call.resolve(js(new JSONObject().put("result", ClockHostReceipts.result(request, outcome, effect.receipt, id))
                                                .put("alarmsRevision", ElizaAlarms.revision(getContext()))));
                                        notifyListeners("proposalsChanged", new JSObject());
                                    } catch (Exception error) {
                                        // error-policy:J1 a lost/partial native effect is not replayed or presented as successful.
                                        try {
                                            client.current();
                                            if (!owner.equals(ClockOwnedAlarms.owner(getContext(), client)))
                                                throw new SecurityException("Alarm result owner changed");
                                            if (!consumed[0]) { call.reject("Alarm changed or could not be saved; refresh the list"); return; }
                                            call.resolve(js(new JSONObject().put("result", ClockHostReceipts.result(request, ClockConsentCoordinator.Result.UNKNOWN))
                                                    .put("alarmsRevision", ElizaAlarms.revision(getContext()))));
                                            notifyListeners("proposalsChanged", new JSObject());
                                        } catch (Exception ownerChanged) { call.reject("Alarm result could not be verified; refresh the list"); }
                                    }
                                }).setNegativeButton("Cancel", (dialog, which) -> cancelLocalAlarm())
                                .setOnCancelListener(dialog -> cancelLocalAlarm()).create();
                        localAlarmDialog.show();
                    } catch (Exception error) {
                        if (localAlarmCall == call) cancelLocalAlarm();
                        call.reject("Native alarm review could not be opened");
                    }
                });
            } catch (Exception error) { call.reject("Alarm inventory or owner changed; refresh the list"); }
        });
    }
    private void cancelLocalAlarm() {
        PluginCall call = localAlarmCall; AlertDialog dialog = localAlarmDialog;
        localAlarmCall = null; localAlarmDialog = null;
        if (dialog != null) dialog.dismiss();
        if (call != null) call.reject("Alarm review cancelled");
    }
    @PluginMethod public void requestAlarmPermission(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!foreground || localAlarmCall != null) throw new SecurityException("Alarm permission owner unavailable");
                ClockHostClient.exact(call.getData(), "permission");
                String permission = ClockHostClient.text(call.getData(), "permission");
                Intent intent;
                if ("exact".equals(permission) && Build.VERSION.SDK_INT >= 31)
                    intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).setData(Uri.parse("package:" + getContext().getPackageName()));
                else if ("fullScreen".equals(permission) && Build.VERSION.SDK_INT >= 34)
                    intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).setData(Uri.parse("package:" + getContext().getPackageName()));
                else if ("notifications".equals(permission)) {
                    if (Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        getActivity().requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 0xC10C);
                        call.resolve(); return;
                    }
                    intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                } else throw new IllegalArgumentException("Unsupported alarm permission");
                getActivity().startActivity(intent); call.resolve();
            } catch (Exception error) { call.reject("Alarm permission settings could not be opened"); }
        });
    }
    @PluginMethod public void cancelClock(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                ClockConsentCoordinator.Identity identity = identity(call);
                Session session = active;
                if (session == null && !retiredScopes.contains(identity.scope)) {
                    withSession(call, restored -> getActivity().runOnUiThread(() -> {
                        try {
                            if (!restored.scope.equals(identity.scope)) throw new SecurityException("Clock cancellation owner changed");
                            restored.dialog.cancelClock(identity); call.resolve(js(new JSONObject().put("cancelled", true)));
                        } catch (Exception error) { retirement.failed(); call.reject("Native Clock cancellation failed"); }
                    }));
                    return;
                }
                if (session != null && session.scope.equals(identity.scope)) session.dialog.cancelClock(identity);
                else if (!retiredScopes.contains(identity.scope)) throw new SecurityException("Clock cancellation owner unavailable");
                call.resolve(js(new JSONObject().put("cancelled", true)));
            } catch (Exception error) { retirement.failed(); call.reject("Native Clock cancellation failed"); }
        });
    }
    @PluginMethod public void requestAgent(PluginCall call) {
        final Session captured = active;
        final ClockAgentRequests.Entry request;
        final String requestId;
        try {
            requestId = requestId(call.getData());
            if (captured == null) throw new SecurityException("Native chat owner unavailable");
            captured.check(); expectedOrigin(call, captured.client);
            request = agentRequests.begin(requestId, captured);
            queuedAgentCalls.put(call, request);
        } catch (Exception error) { call.reject("Native agent request cancelled or owner unavailable"); return; }
        withSession(call, session -> {
            try {
            request.current(session);
            if (captured != session) throw new SecurityException("Native agent owner changed before worker admission");
            JSONObject input = call.getData();
            expectedOrigin(call, session.client);
            String method = ClockHostClient.text(input, "method"), path = ClockHostClient.text(input, "path");
            ClockHostPolicy.agentPath(method, path);
            Map<String, String> headers = new LinkedHashMap<>();
            JSONObject supplied = input.optJSONObject("headers");
            if (supplied != null) {
                java.util.Iterator<String> keys = supplied.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    headers.put(key, ClockHostClient.text(supplied, key));
                }
            }
            String body = input.has("body") && !input.isNull("body") ? ClockHostClient.text(input, "body") : null;
            if ("POST".equals(method)) {
                if (body == null) throw new IllegalArgumentException("Native chat body unavailable");
                body = session.client.agentBody(body);
            } else if (body != null) throw new IllegalArgumentException("Unexpected native GET body");
            Object streaming = input.opt("stream");
            if (streaming != null && streaming != JSONObject.NULL && !(streaming instanceof Boolean)) throw new IllegalArgumentException("Invalid native stream flag");
            if (Boolean.TRUE.equals(streaming)) {
                java.util.concurrent.atomic.AtomicBoolean headSent = new java.util.concurrent.atomic.AtomicBoolean();
                try {
                    session.client.stream(method, path, body, headers, () -> { session.checkOwner(); request.current(active); }, new ClockHostHttp.Stream() {
                        @Override public void connected(java.net.HttpURLConnection connection) { request.connected(connection::disconnect); }
                        @Override public boolean cancelled() { return request.cancelled || active != session || !foreground || retirement.isBlocked(); }
                        @Override public void head(ClockHostHttp.Response response) throws Exception {
                            session.check(); request.current(active); headSent.set(true);
                            call.resolve(js(new JSONObject().put("status", response.status).put("headers", new JSONObject().put("content-type", response.contentType))
                                    .put("data", "").put("streamed", true)));
                            if (response.status == 401) { request.cancel(); getActivity().runOnUiThread(SlotClockPlugin.this::retire); }
                        }
                        @Override public void chunk(String data) throws Exception {
                            session.check(); request.current(active);
                            notifyListeners("agentChunk", js(new JSONObject().put("requestId", requestId).put("data", data)));
                        }
                        @Override public void done() throws Exception {
                            session.check(); request.current(active); notifyListeners("agentChunk", js(new JSONObject().put("requestId", requestId).put("done", true)));
                        }
                    });
                } catch (Exception error) {
                    // error-policy:J1 stream failure never retries an accepted chat or exposes native diagnostics.
                    if (headSent.get()) notifyListeners("agentChunk", js(new JSONObject().put("requestId", requestId).put("error", "Native agent stream interrupted")));
                    else call.reject("Native agent stream unavailable");
                } finally {
                    request.finish();
                    if ("POST".equals(method)) notifyListeners("proposalsChanged", new JSObject());
                }
            } else {
                ClockHostClient.Response response = session.client.request(method, path, body, headers, () -> { session.checkOwner(); request.current(active); }, request::connected);
                session.checkOwner(); request.current(active);
                call.resolve(js(new JSONObject().put("status", response.status).put("headers", new JSONObject().put("content-type", response.contentType)).put("data", response.data)));
                if (response.status == 401) getActivity().runOnUiThread(this::retire);
                if ("POST".equals(method)) notifyListeners("proposalsChanged", new JSObject());
            }
            } finally { finishAgent(call); }
        });
    }
    private static void expectedOrigin(PluginCall call, ClockHostClient client) throws Exception {
        if (!ClockHostPolicy.origin(client.base).equals(ClockHostClient.text(call.getData(), "expectedOrigin")))
            throw new SecurityException("Native agent origin changed");
        if (!client.base.toString().replaceAll("/+$", "").equals(ClockHostClient.text(call.getData(), "expectedBase").replaceAll("/+$", "")))
            throw new SecurityException("Native selected agent base changed");
    }
    private void finishAgent(PluginCall call) {
        ClockAgentRequests.Entry request = queuedAgentCalls.remove(call);
        if (request != null) request.finish();
    }
    private static String requestId(JSONObject input) throws Exception {
        String id = ClockHostClient.text(input, "requestId");
        if (!java.util.UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Invalid native stream identity");
        return id;
    }
    @PluginMethod public void cancelAgentRequest(PluginCall call) {
        try {
            agentRequests.cancel(requestId(call.getData()));
            call.resolve(js(new JSONObject().put("cancelled", true)));
        } catch (Exception error) { call.reject("Native stream cancellation unavailable"); }
    }
    private static JSObject js(JSONObject value) throws Exception { return JSObject.fromJSONObject(value); }
    private void retire() {
        Session session = active;
        if (session == null) return;
        try {
            retirement.retry(() -> {
                if (session.dialog != null) session.dialog.close();
                agentRequests.cancelOwner(session); retiredScopes.add(session.scope); active = null;
            });
        } catch (Exception error) { retirement.failed(); }
    }
    @PluginMethod public void retryRetirement(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            retire();
            if (retirement.isBlocked()) call.reject("Native Clock retirement remains unsettled");
            else { JSObject reply = new JSObject(); reply.put("retired", true); call.resolve(reply); }
        });
    }
    @Override protected void handleOnPause() { foreground = false; cancelLocalAlarm(); retire(); }
    private void refreshAlarmPermission() {
        try { ElizaAlarms.refreshPermissionState(getContext()); }
        catch (RuntimeException error) {
            // error-policy:J1 inventory reads still fail explicitly; lifecycle cannot fabricate a repaired store.
            android.util.Log.e("ElizaClock", "Alarm permission state could not be read", error);
        }
    }
    @Override protected void handleOnResume() { if (retirement.isBlocked()) retire(); foreground = true; refreshAlarmPermission(); }
    @Override protected void handleOnDestroy() { foreground = false; cancelLocalAlarm(); retire(); ElizaAlarmRingingService.unobserve(alarmChanged); workers.shutdownNow(); }
}

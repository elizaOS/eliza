package ai.elizaos.app;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.AlarmClock;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native Clock adapter. Credentials never cross this bridge; server approval requires its Activity gesture.
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
    private interface Work { void run(Session session) throws Exception; }
    private final class Session {
        final ClockHostClient client;
        final JSONObject context;
        final String scope, owner;
        final Map<String, ClockConsentCoordinator.ApprovedEntry> admitted = new ConcurrentHashMap<>();
        final ClockConsentCoordinator coordinator;
        ClockReviewDialog dialog;
        Session(ClockHostClient client, JSONObject context) throws Exception {
            this.client = client; this.context = context; scope = ClockHostClient.text(context, "scope"); owner = client.owner(context);
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
            });
        }
        void admit(ClockHostClient.Proposal proposal) throws Exception {
            check(); admitted.put(proposal.id, ClockHostClient.admitted(context, proposal, owner));
        }
    }
    @Override public void load() { store = new NativeSecureStore(getContext()); }

    private boolean supported() {
        PackageManager manager = getContext().getPackageManager();
        if (manager.checkPermission("com.android.alarm.permission.SET_ALARM", getContext().getPackageName()) != PackageManager.PERMISSION_GRANTED) return false;
        for (ResolveInfo candidate : manager.queryIntentActivities(new Intent(AlarmClock.ACTION_SET_ALARM), PackageManager.MATCH_DEFAULT_ONLY)) {
            if (candidate.activityInfo != null && candidate.activityInfo.enabled && candidate.activityInfo.exported
                    && !getContext().getPackageName().equals(candidate.activityInfo.packageName)) return true;
        }
        return false;
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
                ClockHostClient client = new ClockHostClient(store, store.snapshot(), url -> CookieManager.getInstance().getCookie(url), ZoneId.systemDefault().getId());
                if ("requestAgent".equals(call.getMethodName())) expectedOrigin(call, client);
                JSONObject context = client.context(true);
                getActivity().runOnUiThread(() -> {
                    try {
                        client.current();
                        if (!foreground || retirement.isBlocked()) throw new SecurityException("Native Clock retired during enrollment");
                        if (active == null) { active = new Session(client, context); active.openDialog(); }
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
                    .put("capabilities", new JSONArray(ClockHostClient.CAPABILITIES.split(",")))
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
            ClockHostClient.requiresDecision(session.context, proposal);
            getActivity().runOnUiThread(() -> {
                try {
                    session.check();
                    String scope = "Agent: " + ClockHostClient.text(session.context, "agentId") + "\nOwner: "
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
    private ClockReviewDialog.Callback callback(PluginCall call, ClockHandoff.Request request) {
        return new ClockReviewDialog.Callback() {
            @Override public void completed(ClockConsentCoordinator.Result result, String token) { complete(call, request, result, token); }
            @Override public void failed(Exception error) { reject(call); }
        };
    }
    private static void complete(PluginCall call, ClockHandoff.Request request, ClockConsentCoordinator.Result outcome, String token) {
        try {
            JSONObject reply = new JSONObject();
            if (outcome != null) reply.put("result", ClockHostReceipts.result(request, outcome)).put("receiptPending", false);
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
        enqueue(call, () -> {
            try {
                // Activity pause ends effect authority, but authenticated publication of an already
                // persisted native receipt may finish while the external Clock is foreground.
                session.client.current(); session.client.sameContext(session.context);
                ClockHostClient.Proposal fresh = session.client.require(session.context, proposal.id);
                ClockHostClient.sameProposal(proposal, fresh);
                if (proposal.attemptId == null || !proposal.attemptId.equals(fresh.attemptId)) throw new SecurityException("Clock receipt attempt changed");
                session.client.transition(session.context, fresh, "receipt", ClockHostReceipts.body(fresh, identity, outcome));
                complete(call, proposal.request, outcome, null);
            } catch (Exception error) {
                // error-policy:J2 the journal governs retries: a lost HTTP acknowledgement never redispatches.
                try { call.resolve(js(new JSONObject().put("result", ClockHostReceipts.result(proposal.request, outcome)).put("receiptPending", true))); }
                catch (Exception encoding) { call.reject("Persisted native Clock receipt unavailable"); }
            }
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
                    String key = keys.next(); String lower = key.toLowerCase(Locale.ROOT);
                    if (lower.equals("authorization") || lower.equals("cookie") || lower.equals("x-eliza-csrf") || lower.startsWith("x-eliza-device-")) continue;
                    String value = ClockHostClient.text(supplied, key); ClockHostPolicy.header(key, value); headers.put(key, value);
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
    @Override protected void handleOnPause() { foreground = false; retire(); }
    @Override protected void handleOnResume() { if (retirement.isBlocked()) retire(); foreground = true; }
    @Override protected void handleOnDestroy() { foreground = false; retire(); workers.shutdownNow(); }
}

package ai.elizaos.app;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLDecoder;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Authenticated native HTTP only. Invoke on the bounded plugin worker, never under a journal/store lock. */
final class ClockHostClient {
    interface Cookies { String get(String url); }
    static final String CAPABILITIES = "clock.handoff.v1,clock.handoff.v2";
    static final String OWNED_CAPABILITIES = "clock.alarms.v1";
    interface AlarmMetadata {
        JSONObject context(ClockHostClient client) throws Exception;
        default void rejected(ClockHostClient client) throws Exception { }
    }
    static final class Response {
        final int status;
        final String data, contentType;
        Response(int status, String data, String contentType) { this.status = status; this.data = data; this.contentType = contentType; }
        JSONObject json() throws Exception {
            if (status < 200 || status >= 300) throw new SecurityException("Native device host rejected request");
            return object(data);
        }
    }
    static final class Proposal {
        final String id, digest, state, expiresAt, attemptId;
        final ClockHandoff.Request request;
        final JSONObject operation;
        final JSONObject raw;
        Proposal(JSONObject raw, JSONObject context) throws Exception {
            this.raw = raw;
            id = identifier(text(raw, "id")); digest = digest(text(raw, "digest"));
            state = text(raw, "state"); expiresAt = text(raw, "expiresAt"); Instant.parse(expiresAt);
            JSONObject payload = raw.getJSONObject("payload");
            if (!"device_action".equals(text(payload, "action")) || integer(payload, "version") != 1
                    || !text(raw, "subjectUserId").equals(text(context, "subjectUserId"))
                    || !text(payload, "installationId").equals(text(context, "installationId"))
                    || !text(payload, "enrollmentId").equals(text(context, "enrollmentId")))
                throw new SecurityException("Clock proposal owner changed");
            // Clock alarms never inherit workflow scheduling or selected-source authority.
            if (payload.has("workflow")) throw new SecurityException("Clock workflow handoff unavailable");
            operation = payload.getJSONObject("operation"); request = decode(operation);
            Object executionValue = raw.opt("execution");
            if (executionValue != null && executionValue != JSONObject.NULL && !(executionValue instanceof JSONObject))
                throw new IllegalArgumentException("Invalid native execution claim");
            JSONObject execution = raw.optJSONObject("execution");
            attemptId = execution == null ? null : identifier(text(execution, "attemptId"));
        }
        JSONObject summary() throws Exception {
            return new JSONObject().put("id", id).put("digest", digest).put("state", state)
                    .put("expiresAt", expiresAt).put("operation", new JSONObject(operation.toString()));
        }
    }
    final NativeSecureStore store;
    final NativeSecureStore.Snapshot snapshot;
    final NativeSecureStore.DeviceIdentity device;
    final URI base;
    private final Cookies cookies;
    private final String cookie, bearer, profileId;
    private volatile boolean authorizationRejected;
    final String timeZone;
    private final AlarmMetadata alarmMetadata;

    ClockHostClient(NativeSecureStore store, NativeSecureStore.Snapshot snapshot, Cookies cookies, String timeZone) throws Exception {
        this(store, snapshot, cookies, timeZone, null);
    }
    ClockHostClient(NativeSecureStore store, NativeSecureStore.Snapshot snapshot, Cookies cookies, String timeZone,
                    AlarmMetadata alarmMetadata) throws Exception {
        this.store = store; this.snapshot = snapshot; this.cookies = cookies; this.timeZone = timeZone;
        this.alarmMetadata = alarmMetadata;
        device = snapshot.requireClockDevice();
        JSONObject profile = object(snapshot.require("runtime.active_server"));
        profileId = text(profile, "id");
        String kind = text(profile, "kind");
        if (!Arrays.asList("local", "remote", "cloud").contains(kind)) throw new SecurityException("Unsupported native profile");
        base = ClockHostPolicy.base(text(profile, "apiBase"));
        bearer = profile.has("accessToken") && !profile.isNull("accessToken") ? text(profile, "accessToken") : null;
        cookie = cleanCookie(cookies.get(base.toString()));
        if (bearer == null && cookie.isEmpty()) throw new SecurityException("Native authenticated agent session unavailable");
        if (bearer != null && (bearer.length() > 8192 || bearer.matches(".*[\\r\\n].*"))) throw new SecurityException("Invalid native session");
        current();
    }
    void current() throws Exception {
        if (authorizationRejected) throw new SecurityException("Native authentication was rejected");
        store.assertCurrent(snapshot);
        if (!cookie.equals(cleanCookie(cookies.get(base.toString())))) throw new SecurityException("Native cookie owner changed");
        if (!timeZone.equals(java.time.ZoneId.systemDefault().getId())) throw new SecurityException("Native phone timezone changed");
    }
    JSONObject context(boolean enroll) throws Exception {
        if (enroll) request("POST", "/api/client-devices/register", new JSONObject().put("label", alarmMetadata == null ? "Android Clock" : "Eliza Clock").put("workflowProtocol", 1).toString(), null).json();
        JSONObject context = request("GET", "/api/client-devices/context", null, null).json();
        exact(context, "agentId", "subjectUserId", "installationId", "enrollmentId", "scope");
        identifier(text(context, "agentId")); identifier(text(context, "enrollmentId")); digest(text(context, "scope"));
        if (text(context, "subjectUserId").length() > 256 || !device.getInstallationId().equals(text(context, "installationId")))
            throw new SecurityException("Native enrollment changed");
        return context;
    }
    void sameContext(JSONObject expected) throws Exception {
        JSONObject actual = context(false);
        for (String key : new String[]{"agentId", "subjectUserId", "installationId", "enrollmentId", "scope"})
            if (!text(expected, key).equals(text(actual, key))) throw new SecurityException("Native Clock scope changed");
    }
    String owner(JSONObject context) throws Exception {
        return ClockHostPolicy.hash(profileId + "\n" + base + "\n" + text(context, "scope") + "\n"
                + ClockHostPolicy.hash((bearer == null ? "" : bearer) + "\n" + cookie));
    }
    String alarmOwner(JSONObject context) throws Exception {
        return ClockHostPolicy.hash(profileId + "\n" + base + "\n" + text(context, "subjectUserId")
                + "\n" + text(context, "agentId") + "\n" + device.getInstallationId());
    }
    String localFingerprint() {
        return ClockHostPolicy.hash(profileId + "\n" + base + "\n" + device.getInstallationId() + "\n"
                + ClockHostPolicy.hash((bearer == null ? "" : bearer) + "\n" + cookie));
    }
    String capabilities() { return alarmMetadata == null ? CAPABILITIES : OWNED_CAPABILITIES; }
    List<Proposal> proposals(JSONObject context) throws Exception {
        JSONArray rows = request("GET", "/api/client-devices/proposals", null, null).json().getJSONArray("proposals");
        List<Proposal> result = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            JSONObject operation = row.getJSONObject("payload").getJSONObject("operation");
            if ((alarmMetadata == null ? "clock_handoff" : "clock_alarm").equals(operation.opt("type"))) result.add(new Proposal(row, context));
        }
        return result;
    }
    Proposal require(JSONObject context, String id) throws Exception {
        for (Proposal proposal : proposals(context)) if (proposal.id.equals(id)) return proposal;
        throw new SecurityException("Owned Clock proposal unavailable");
    }
    Proposal transition(JSONObject context, Proposal original, String transition, JSONObject body) throws Exception {
        JSONObject response = request("POST", "/api/client-devices/proposals/" + original.id + "/" + transition, body.toString(), null).json();
        JSONObject row = response.getJSONObject("proposal"); row.put("digest", response.get("digest"));
        Proposal changed = new Proposal(row, context);
        sameProposal(original, changed);
        return changed;
    }
    static void sameProposal(Proposal a, Proposal b) {
        if (!a.id.equals(b.id) || !a.digest.equals(b.digest) || !sameRequest(a.request, b.request))
            throw new SecurityException("Clock proposal changed");
    }
    static boolean sameRequest(ClockHandoff.Request a, ClockHandoff.Request b) {
        return a.action == b.action && a.hour == b.hour && a.minute == b.minute && a.snoozeMinutes == b.snoozeMinutes
                && Objects.equals(a.label, b.label) && Objects.equals(a.timeZone, b.timeZone) && Objects.equals(a.days, b.days)
                && a.owned == b.owned && Objects.equals(a.alarmId, b.alarmId) && a.enabled == b.enabled;
    }
    /** Preparation is available only before any execution attempt and still requires a new native gesture. */
    static boolean requiresDecision(JSONObject context, Proposal proposal) throws Exception {
        if (proposal.attemptId != null || !Instant.parse(proposal.expiresAt).isAfter(Instant.now()))
            throw new SecurityException("Clock proposal already claimed or expired");
        if ("pending".equals(proposal.state)) return true;
        if (!"approved".equals(proposal.state)) throw new SecurityException("Clock proposal cannot be prepared");
        requireApprovalBinding(context, proposal);
        return false;
    }
    private static void requireApprovalBinding(JSONObject context, Proposal proposal) throws Exception {
        if (!text(proposal.raw, "resolvedBy").equals(text(context, "subjectUserId"))
                || !text(proposal.raw, "resolutionReason").equals("Explicit device review:" + proposal.digest))
            throw new SecurityException("Clock native approval binding unavailable");
    }
    static ClockConsentCoordinator.ApprovedEntry admitted(JSONObject context, Proposal proposal, String owner) throws Exception {
        if (proposal.attemptId == null || !Arrays.asList("executing", "done", "reconciliation_required").contains(proposal.state))
            throw new SecurityException("Native Clock execution claim unavailable");
        JSONObject execution = proposal.raw.getJSONObject("execution");
        if (execution.isNull("dispatchStartedAt") || !execution.has("dispatchStartedAt")) throw new SecurityException("Clock dispatch claim unavailable");
        requireApprovalBinding(context, proposal);
        return new ClockConsentCoordinator.ApprovedEntry(new ClockConsentCoordinator.Identity(text(context, "scope"), proposal.id, proposal.id),
                proposal.request, owner, ClockHostPolicy.hash(proposal.digest + "\n" + proposal.attemptId + "\n" + text(context, "scope")));
    }
    JSONObject metadataContext() throws Exception {
        if (alarmMetadata != null) return alarmMetadata.context(this);
        return new JSONObject().put("sensitive", false).put("revision", snapshot.getGeneration()).put("timeZone", timeZone);
    }
    String agentBody(String raw) throws Exception {
        JSONObject body = object(raw);
        JSONObject metadata = body.has("metadata") ? body.getJSONObject("metadata") : new JSONObject();
        metadata.put("clientDevice", new JSONObject().put("context", metadataContext())); body.put("metadata", metadata);
        return body.toString();
    }
    Response request(String method, String path, String body, Map<String, String> callerHeaders) throws Exception {
        return request(method, path, body, callerHeaders, () -> {}, ignored -> {});
    }
    Response request(String method, String path, String body, Map<String, String> callerHeaders, ClockHostHttp.Fence requestFence,
                     java.util.function.Consumer<Runnable> connected) throws Exception {
        ClockHostHttp.Response response = ClockHostHttp.request(ClockHostPolicy.endpoint(base, path), method, body, headers(callerHeaders),
                () -> { current(); requestFence.current(); }, null, connection -> connected.accept(connection::disconnect));
        if (response.status == 401) {
            authorizationRejected = true;
            if (alarmMetadata != null) alarmMetadata.rejected(this);
        }
        secretFree(response.data);
        return new Response(response.status, response.data, response.contentType);
    }
    void stream(String method, String path, String body, Map<String, String> callerHeaders, ClockHostHttp.Fence requestFence, ClockHostHttp.Stream observer) throws Exception {
        List<String> secrets = secrets();
        int keep = 0; for (String secret : secrets) keep = Math.max(keep, secret.length() - 1);
        final int retained = keep;
        ClockHostHttp.request(ClockHostPolicy.endpoint(base, path), method, body, headers(callerHeaders), () -> { current(); requestFence.current(); }, new ClockHostHttp.Stream() {
            final StringBuilder pending = new StringBuilder();
            @Override public void connected(HttpURLConnection connection) { observer.connected(connection); }
            @Override public void head(ClockHostHttp.Response response) throws Exception {
                observer.head(response);
                if (response.status == 401) {
                    authorizationRejected = true;
                    if (alarmMetadata != null) alarmMetadata.rejected(ClockHostClient.this);
                }
            }
            @Override public boolean cancelled() { return observer.cancelled(); }
            @Override public void chunk(String data) throws Exception {
                pending.append(data); secretFree(pending.toString());
                int end = pending.length() - retained;
                if (end > 0) {
                    if (Character.isHighSurrogate(pending.charAt(end - 1))) end--;
                    if (end > 0) { observer.chunk(pending.substring(0, end)); pending.delete(0, end); }
                }
            }
            @Override public void done() throws Exception {
                secretFree(pending.toString());
                if (pending.length() > 0) observer.chunk(pending.toString());
                observer.done();
            }
        });
    }
    private Map<String, String> headers(Map<String, String> callerHeaders) throws Exception {
        Map<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("Accept", "application/json"); headers.put("Content-Type", "application/json");
        headers.putAll(ClockHostPolicy.headers(callerHeaders, bearer, cookie));
        headers.put("x-eliza-device-id", device.getInstallationId()); headers.put("x-eliza-device-key", device.getDeviceKey());
        headers.put("x-eliza-device-capabilities", capabilities());
        if (bearer != null) headers.put("Authorization", "Bearer " + bearer);
        if (!cookie.isEmpty()) headers.put("Cookie", cookie);
        String csrf = ClockHostPolicy.csrf(cookie);
        if (csrf != null) headers.put("x-eliza-csrf", csrf);
        return headers;
    }
    private List<String> secrets() throws Exception {
        List<String> result = new ArrayList<>(); result.add(device.getDeviceKey());
        if (bearer != null) result.add(bearer);
        for (String part : cookie.split(";")) {
            int at = part.indexOf('=');
            if (at >= 0) {
                String value = URLDecoder.decode(part.substring(at + 1).trim(), "UTF-8");
                if (value.length() >= 16) result.add(value);
            }
        }
        return result;
    }
    private void secretFree(String value) throws Exception {
        for (String secret : secrets()) if (value.contains(secret)) throw new SecurityException("Native response contains credentials");
    }
    static JSONObject object(String value) throws Exception {
        JSONTokener parser = new JSONTokener(value); Object result = parser.nextValue();
        if (!(result instanceof JSONObject) || parser.nextClean() != 0) throw new IllegalArgumentException("Invalid native JSON object");
        return (JSONObject) result;
    }
    static String text(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).indexOf('\0') >= 0)
            throw new IllegalArgumentException("Invalid native text field");
        return (String) value;
    }
    static int integer(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Integer)) throw new IllegalArgumentException("Invalid native integer");
        return (Integer) value;
    }
    static String identifier(String value) {
        if (!value.matches("[-A-Za-z0-9_]{1,128}")) throw new IllegalArgumentException("Invalid native identifier");
        return value;
    }
    static String digest(String value) {
        if (!value.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid native digest");
        return value;
    }
    static void exact(JSONObject object, String... fields) {
        HashSet<String> keys = new HashSet<>(Arrays.asList(fields));
        if (object.length() != keys.size()) throw new IllegalArgumentException("Unexpected native fields");
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) if (!keys.contains(iterator.next())) throw new IllegalArgumentException("Unexpected native fields");
    }
    static ClockHandoff.Request decode(JSONObject op) throws Exception {
        if ("clock_alarm".equals(text(op, "type"))) return decodeOwned(op);
        if (!"clock_handoff".equals(text(op, "type"))) throw new IllegalArgumentException("Unsupported native operation");
        switch (text(op, "action")) {
            case "set":
                if (op.has("days")) exact(op, "type", "action", "hour", "minute", "label", "timeZone", "days");
                else exact(op, "type", "action", "hour", "minute", "label", "timeZone");
                Object label = op.get("label"); if (!(label instanceof String)) throw new IllegalArgumentException("Invalid Clock label");
                if (!op.has("days")) return ClockHandoff.Request.set(integer(op, "hour"), integer(op, "minute"), (String) label, text(op, "timeZone"));
                JSONArray days = op.getJSONArray("days");
                if (days.length() > 7) throw new IllegalArgumentException("Invalid Clock repeat days");
                List<Integer> selected = new ArrayList<>();
                for (int i = 0; i < days.length(); i++) {
                    Object day = days.get(i); if (!(day instanceof Integer)) throw new IllegalArgumentException("Invalid Clock repeat day");
                    selected.add((Integer) day);
                }
                return ClockHandoff.Request.set(integer(op, "hour"), integer(op, "minute"), (String) label, text(op, "timeZone"), selected);
            case "show": exact(op, "type", "action"); return ClockHandoff.Request.show();
            case "dismiss": exact(op, "type", "action"); return ClockHandoff.Request.dismiss();
            case "snooze": exact(op, "type", "action", "snoozeMinutes"); return ClockHandoff.Request.snooze(integer(op, "snoozeMinutes"));
            default: throw new IllegalArgumentException("Unsupported native Clock action");
        }
    }
    private static ClockHandoff.Request decodeOwned(JSONObject op) throws Exception {
        String action = text(op, "action");
        switch (action) {
            case "set":
            case "update":
                if ("set".equals(action)) exact(op, "type", "action", "hour", "minute", "label", "timeZone", "days");
                else exact(op, "type", "action", "alarmId", "hour", "minute", "label", "timeZone", "days");
                Object label = op.get("label"); if (!(label instanceof String)) throw new IllegalArgumentException("Invalid alarm label");
                JSONArray days = op.getJSONArray("days");
                if (days.length() > 7) throw new IllegalArgumentException("Invalid alarm repeat days");
                List<Integer> repeat = new ArrayList<>();
                for (int i = 0; i < days.length(); i++) {
                    Object day = days.get(i); if (!(day instanceof Integer)) throw new IllegalArgumentException("Invalid alarm repeat day");
                    repeat.add((Integer) day);
                }
                if ("update".equals(action)) return ClockHandoff.Request.update(integer(op, "hour"), integer(op, "minute"),
                        (String) label, text(op, "timeZone"), repeat, text(op, "alarmId"));
                return ClockHandoff.Request.owned(ClockHandoff.Request.set(integer(op, "hour"), integer(op, "minute"),
                        (String) label, text(op, "timeZone"), repeat), null, false);
            case "show": exact(op, "type", "action"); return ClockHandoff.Request.owned(ClockHandoff.Request.show(), null, false);
            case "delete": exact(op, "type", "action", "alarmId"); return ClockHandoff.Request.delete(text(op, "alarmId"));
            case "enable":
                exact(op, "type", "action", "alarmId", "enabled");
                if (!(op.get("enabled") instanceof Boolean)) throw new IllegalArgumentException("Invalid alarm enabled state");
                return ClockHandoff.Request.enable(text(op, "alarmId"), op.getBoolean("enabled"));
            case "dismiss":
                exact(op, "type", "action", "alarmId");
                return ClockHandoff.Request.owned(ClockHandoff.Request.dismiss(), text(op, "alarmId"), false);
            case "snooze":
                exact(op, "type", "action", "alarmId", "minutes");
                return ClockHandoff.Request.owned(ClockHandoff.Request.snooze(integer(op, "minutes")), text(op, "alarmId"), false);
            default: throw new IllegalArgumentException("Unsupported owned alarm action");
        }
    }
    private static String cleanCookie(String cookie) {
        if (cookie == null) return "";
        if (cookie.length() > 16384 || cookie.indexOf('\r') >= 0 || cookie.indexOf('\n') >= 0)
            throw new SecurityException("Invalid native cookies");
        return cookie;
    }
}

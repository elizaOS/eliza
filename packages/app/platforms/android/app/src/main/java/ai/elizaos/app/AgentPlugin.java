package ai.elizaos.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Iterator;

@CapacitorPlugin(name = "Agent")
public class AgentPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            ElizaAgentService.start(getContext());
            call.resolve(status("starting"));
        } catch (RuntimeException e) {
            call.reject("Failed to start local agent service", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            ElizaAgentService.stop(getContext());
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (RuntimeException e) {
            call.reject("Failed to stop local agent service", e);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        String token = ElizaAgentService.localAgentToken(getContext());
        call.resolve(status(token == null || token.trim().isEmpty() ? "starting" : "running"));
    }

    @PluginMethod
    public void getLocalAgentBootState(PluginCall call) {
        try {
            call.resolve(toJsObject(ElizaAgentService.getLocalAgentBootState(getContext())));
        } catch (JSONException e) {
            call.reject("Failed to read local agent boot state", e);
        }
    }

    @PluginMethod
    public void getLocalAgentToken(PluginCall call) {
        JSObject result = new JSObject();
        String token = ElizaAgentService.localAgentToken(getContext());
        result.put("available", token != null && !token.trim().isEmpty());
        result.put("token", token == null || token.trim().isEmpty() ? JSONObject.NULL : token.trim());
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        try {
            // Prime the per-process token from the recovery file so requests
            // routed by a WebView process that didn't start the agent still
            // carry the bearer token.
            ElizaAgentService.localAgentToken(getContext());
            JSONObject request = new JSONObject();
            putIfPresent(request, "method", call.getString("method"));
            putIfPresent(request, "path", call.getString("path"));
            putIfPresent(request, "body", call.getString("body"));
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null) {
                request.put("timeoutMs", timeoutMs);
            }
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                request.put("headers", headers);
            }
            call.resolve(toJsObject(new JSONObject(ElizaAgentService.requestLocalAgent(request.toString()))));
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), e);
        } catch (IOException e) {
            call.reject("Local agent request failed", e);
        } catch (JSONException e) {
            call.reject("Local agent returned an invalid response", e);
        }
    }

    /**
     * Streaming variant of {@link #request}. Resolves immediately with a
     * {@code streamId}, then pushes the loopback response incrementally as
     * {@code agentStream*} Capacitor events tagged with that id — so SSE token
     * frames reach the WebView as they arrive instead of buffering the whole
     * body (the chat reply finally streams on mobile). The WebView falls back to
     * {@link #request} when this is unavailable or the head never arrives.
     */
    @PluginMethod
    public void requestStream(PluginCall call) {
        final String streamId = java.util.UUID.randomUUID().toString();
        try {
            // Prime the per-process token (see request()).
            ElizaAgentService.localAgentToken(getContext());
            JSONObject request = new JSONObject();
            putIfPresent(request, "method", call.getString("method"));
            putIfPresent(request, "path", call.getString("path"));
            putIfPresent(request, "body", call.getString("body"));
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null) {
                request.put("timeoutMs", timeoutMs);
            }
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                request.put("headers", headers);
            }
            final String requestJson = request.toString();

            // Resolve first so the WebView attaches its agentStream* listeners
            // for this streamId before the background thread starts emitting.
            JSObject ack = new JSObject();
            ack.put("streamId", streamId);
            call.resolve(ack);

            new Thread(() -> ElizaAgentService.requestLocalAgentStream(requestJson, (String eventJson) -> {
                try {
                    JSONObject event = new JSONObject(eventJson);
                    String type = event.optString("type");
                    JSObject payload = new JSObject();
                    payload.put("streamId", streamId);
                    if ("response".equals(type)) {
                        payload.put("status", event.optInt("status"));
                        payload.put("statusText", event.optString("statusText"));
                        JSONObject h = event.optJSONObject("headers");
                        payload.put("headers", h != null ? h : new JSONObject());
                        notifyListeners("agentStreamResponse", payload);
                    } else if ("chunk".equals(type)) {
                        payload.put("dataBase64", event.optString("dataBase64"));
                        notifyListeners("agentStreamChunk", payload);
                    } else if ("complete".equals(type)) {
                        if (event.has("error")) {
                            payload.put("error", event.optString("error"));
                        }
                        notifyListeners("agentStreamComplete", payload);
                    }
                } catch (JSONException ignored) {
                    // A malformed envelope must not kill the stream.
                }
            })).start();
        } catch (JSONException e) {
            call.reject("Local agent stream request was invalid", e);
        }
    }

    private static final int MAX_EVENT_SUBSCRIPTIONS = 2;
    private static final java.util.regex.Pattern SUBSCRIPTION_ID =
        java.util.regex.Pattern.compile("^[A-Za-z0-9-]{8,64}$");
    private final java.util.concurrent.ConcurrentHashMap<String, ElizaAgentService.LocalStreamHandle>
        eventSubscriptions = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * Live agent-event feed (WS {@code agent_event} parity for the port-free
     * app). Takes {@code {streams: string[], subscriptionId?: string}}; resolves
     * {@code {subscriptionId}} at once, then emits {@code agentEvent}
     * Capacitor events tagged with that id:
     *   {subscriptionId, type:"subscribed", streams}
     *   {subscriptionId, type:"event", event:<agent_event envelope>}
     *   {subscriptionId, type:"dropped", count}
     *   {subscriptionId, type:"end", error?}   (terminal; no replay — resubscribe)
     * A caller-chosen {@code subscriptionId} lets the WebView filter events
     * before this call resolves.
     */
    @PluginMethod
    public void subscribeEvents(PluginCall call) {
        try {
            String requested = call.getString("subscriptionId");
            final String subscriptionId = requested == null
                ? java.util.UUID.randomUUID().toString()
                : requested;
            if (!SUBSCRIPTION_ID.matcher(subscriptionId).matches()) {
                call.reject("Invalid subscriptionId");
                return;
            }
            org.json.JSONArray streams = call.getArray("streams");
            JSONObject request = new JSONObject().put("streams", streams == null ? new org.json.JSONArray() : streams);
            final ElizaAgentService.LocalStreamHandle handle = new ElizaAgentService.LocalStreamHandle();
            synchronized (eventSubscriptions) {
                if (eventSubscriptions.containsKey(subscriptionId)) {
                    call.reject("subscriptionId already active");
                    return;
                }
                if (eventSubscriptions.size() >= MAX_EVENT_SUBSCRIPTIONS) {
                    call.reject("Too many event subscriptions");
                    return;
                }
                eventSubscriptions.put(subscriptionId, handle);
            }
            ElizaAgentService.localAgentToken(getContext());
            final String requestJson = request.toString();
            JSObject ack = new JSObject();
            ack.put("subscriptionId", subscriptionId);
            call.resolve(ack);
            Thread worker = new Thread(() -> {
                try {
                    ElizaAgentService.subscribeLocalAgentEvents(requestJson, (String eventJson) -> {
                        try {
                            JSObject payload = toJsObject(new JSONObject(eventJson));
                            payload.put("subscriptionId", subscriptionId);
                            notifyListeners("agentEvent", payload);
                        } catch (JSONException ignored) {
                            // A malformed envelope must not kill the feed.
                        }
                    }, handle);
                } finally {
                    eventSubscriptions.remove(subscriptionId, handle);
                }
            }, "agent-events");
            worker.setDaemon(true);
            worker.start();
        } catch (JSONException e) {
            call.reject("Event subscription request was invalid", e);
        }
    }

    /** Ends one feed; its {@code agentEvent} stream finishes with a plain {@code end}. */
    @PluginMethod
    public void unsubscribeEvents(PluginCall call) {
        String subscriptionId = call.getString("subscriptionId");
        ElizaAgentService.LocalStreamHandle handle =
            subscriptionId == null ? null : eventSubscriptions.remove(subscriptionId);
        if (handle != null) handle.cancel();
        JSObject result = new JSObject();
        result.put("ok", handle != null);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        for (ElizaAgentService.LocalStreamHandle handle : eventSubscriptions.values()) handle.cancel();
        eventSubscriptions.clear();
        super.handleOnDestroy();
    }

    private static JSObject status(String state) {
        JSObject result = new JSObject();
        String token = ElizaAgentService.localAgentToken();
        result.put("state", state);
        result.put("agentName", "eliza");
        result.put("port", 31337);
        result.put("tokenAvailable", token != null && !token.trim().isEmpty());
        return result;
    }

    private static void putIfPresent(JSONObject target, String key, String value) throws JSONException {
        if (value == null) return;
        target.put(key, value);
    }

    private static JSObject toJsObject(JSONObject source) throws JSONException {
        JSObject target = new JSObject();
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            target.put(key, source.get(key));
        }
        return target;
    }
}

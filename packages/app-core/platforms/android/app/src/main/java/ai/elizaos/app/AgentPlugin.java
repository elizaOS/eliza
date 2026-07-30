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
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                request.put("headers", headers);
            }
            request.put("requestId", streamId);
            final String requestJson = request.toString();
            if (!ElizaAgentService.registerLocalAgentStream(streamId)) {
                call.reject("Local agent stream id is already active");
                return;
            }

            // Resolve first so the WebView attaches its agentStream* listeners
            // for this streamId before the background thread starts emitting.
            JSObject ack = new JSObject();
            ack.put("streamId", streamId);
            call.resolve(ack);

            try {
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
                    } catch (JSONException error) {
                        // error-policy:J1 native bridge boundary: malformed
                        // agent frames terminate the owner-visible stream.
                        JSObject failure = new JSObject();
                        failure.put("streamId", streamId);
                        failure.put("error", "Local agent emitted an invalid stream frame");
                        notifyListeners("agentStreamComplete", failure);
                    }
                })).start();
            } catch (RuntimeException error) {
                ElizaAgentService.cancelLocalAgentStream(streamId);
                // error-policy:J1 native bridge boundary: the Capacitor call
                // already returned its stream id, so startup failure must be a
                // terminal stream event rather than an unhandled exception.
                JSObject failure = new JSObject();
                failure.put("streamId", streamId);
                failure.put("error", "Local agent stream worker failed to start");
                notifyListeners("agentStreamComplete", failure);
            }
        } catch (JSONException e) {
            call.reject("Local agent stream request was invalid", e);
        }
    }

    @PluginMethod
    public void cancelRequestStream(PluginCall call) {
        String streamId = call.getString("streamId");
        if (streamId == null || streamId.trim().isEmpty()) {
            call.reject("streamId is required");
            return;
        }
        JSObject result = new JSObject();
        result.put("cancelled", ElizaAgentService.cancelLocalAgentStream(streamId));
        call.resolve(result);
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

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
        String token = ElizaAgentService.localAgentToken();
        call.resolve(status(token == null || token.trim().isEmpty() ? "starting" : "running"));
    }

    @PluginMethod
    public void getLocalAgentToken(PluginCall call) {
        JSObject result = new JSObject();
        String token = ElizaAgentService.localAgentToken();
        result.put("available", token != null && !token.trim().isEmpty());
        result.put("token", token == null || token.trim().isEmpty() ? JSONObject.NULL : token.trim());
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        try {
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

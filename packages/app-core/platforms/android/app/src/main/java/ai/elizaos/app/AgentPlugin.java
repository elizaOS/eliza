package ai.elizaos.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "Agent")
public class AgentPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        call.resolve(cloudOnlyStatus());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("cloudOnly", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(cloudOnlyStatus());
    }

    @PluginMethod
    public void getLocalAgentToken(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", false);
        result.put("token", JSONObject.NULL);
        result.put("cloudOnly", true);
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        call.reject("Local agent runtime is not bundled in the android-cloud build");
    }

    private static JSObject cloudOnlyStatus() {
        JSObject result = new JSObject();
        result.put("state", "cloud_only");
        result.put("agentName", JSONObject.NULL);
        result.put("port", JSONObject.NULL);
        result.put("startedAt", JSONObject.NULL);
        result.put("error", JSONObject.NULL);
        result.put("cloudOnly", true);
        return result;
    }
}

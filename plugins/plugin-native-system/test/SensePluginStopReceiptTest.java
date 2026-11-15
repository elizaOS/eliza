package ai.eliza.plugins.system;

import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

/** The real plugin and client over a controlled same-signer provider. */
public final class SensePluginStopReceiptTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static Bundle receipt(String state) {
        Bundle value = new Bundle();
        value.putString("state", state);
        value.putString("label", "Stopped");
        value.putBoolean("saved", true);
        value.putBoolean("consented", true);
        value.putBoolean("listening", false);
        value.putBoolean("microphoneOpen", false);
        return value;
    }

    private static JSObject call(SensePlugin plugin, String method, Bundle reply) {
        plugin.getActivity().resolver.result = reply;
        PluginCall call = new PluginCall();
        switch (method) {
            case "pause": plugin.pause(call); break;
            case "turnOff": plugin.turnOff(call); break;
            case "status": plugin.status(call); break;
            default: throw new AssertionError("unexpected method");
        }
        check(method.equals(plugin.getActivity().resolver.method), "wrong provider operation");
        return call.result;
    }

    private static void refused(SensePlugin plugin, String method, Bundle reply) {
        JSObject result = call(plugin, method, reply);
        check(result.size() == 1 && Boolean.FALSE.equals(result.get("available")),
            method + " fabricated a stop proof from " + reply + " → " + result);
    }

    private static void accepted(SensePlugin plugin, String method, String state) {
        JSObject result = call(plugin, method, receipt(state));
        check(Boolean.TRUE.equals(result.get("available")) && Boolean.TRUE.equals(result.get("saved"))
            && state.equals(result.get("state")) && Boolean.FALSE.equals(result.get("listening"))
            && Boolean.FALSE.equals(result.get("microphoneOpen")) && Boolean.TRUE.equals(result.get("consented"))
            && "Stopped".equals(result.get("label")), method + " lost its complete saved receipt");
    }

    private static void unavailable(SensePlugin plugin, String method, String reason) {
        PluginCall call = new PluginCall();
        switch (method) {
            case "pause": plugin.pause(call); break;
            case "turnOff": plugin.turnOff(call); break;
            case "status": plugin.status(call); break;
            default: throw new AssertionError("unexpected method");
        }
        JSObject result = call.result;
        check(Boolean.FALSE.equals(result.get("available")), method + " fabricated availability");
        check(reason == null ? result.size() == 1
            : result.size() == 2 && reason.equals(result.get("reason")),
            method + " did not preserve package absence/unknown: " + result);
    }

    public static void main(String[] args) {
        SensePlugin plugin = new SensePlugin();
        for (String method : new String[]{"status", "pause", "turnOff"}) {
            plugin.getActivity().packages.installed = false;
            unavailable(plugin, method, "not-installed");
            plugin.getActivity().packages.readFailure = true;
            unavailable(plugin, method, null);
            plugin.getActivity().packages.readFailure = false;
            plugin.getActivity().packages.installed = true;
            plugin.getActivity().packages.signer = -1;
            unavailable(plugin, method, null);
            plugin.getActivity().packages.signer = 0;
        }
        refused(plugin, "turnOff", new Bundle());
        refused(plugin, "pause", new Bundle());
        for (String method : new String[]{"turnOff", "pause"}) {
            String state = method.equals("turnOff") ? "OFF" : "PAUSED_USER";
            refused(plugin, method, null);
            for (String field : new String[]{"state", "saved", "listening", "microphoneOpen"}) {
                Bundle missing = receipt(state);
                missing.remove(field);
                refused(plugin, method, missing);
                Bundle wrongType = receipt(state);
                wrongType.put(field, field.equals("state") ? 1 : "false");
                refused(plugin, method, wrongType);
            }
            Bundle unsaved = receipt(state);
            unsaved.putBoolean("saved", false);
            refused(plugin, method, unsaved);
            Bundle stillListening = receipt(state);
            stillListening.putBoolean("listening", true);
            refused(plugin, method, stillListening);
            Bundle stillOpen = receipt(state);
            stillOpen.putBoolean("microphoneOpen", true);
            refused(plugin, method, stillOpen);
            refused(plugin, method, receipt("LISTENING"));
            refused(plugin, method, receipt("UNRECOGNIZED"));
            accepted(plugin, method, state);
        }
        refused(plugin, "turnOff", receipt("PAUSED_USER"));
        refused(plugin, "pause", receipt("PAUSED_CALL"));
        accepted(plugin, "pause", "OFF");
        accepted(plugin, "pause", "PERMISSION_REQUIRED");

        JSObject oldStatus = call(plugin, "status", new Bundle());
        check(Boolean.TRUE.equals(oldStatus.get("available")) && "OFF".equals(oldStatus.get("state"))
            && Boolean.FALSE.equals(oldStatus.get("listening")) && !oldStatus.containsKey("saved"),
            "legacy status display changed");
        Bundle live = receipt("LISTENING");
        live.putBoolean("listening", true);
        live.putBoolean("microphoneOpen", true);
        JSObject status = call(plugin, "status", live);
        check("LISTENING".equals(status.get("state")) && Boolean.TRUE.equals(status.get("listening"))
            && Boolean.TRUE.equals(status.get("microphoneOpen")) && !status.containsKey("saved"),
            "live status display changed");
        System.out.println("PASS real Sense action bridge refuses incomplete or unsuccessful stop receipts");
    }
}

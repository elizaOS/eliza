package ai.eliza.plugins.system;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Common image-listener bridge; a product may retain a legacy plugin-name alias. */
@CapacitorPlugin(name="ElizaSense")
public class SensePlugin extends Plugin {
    private final long bridgeGeneration = SenseListenerClient.nextInvocationBridge();
    private volatile boolean destroyed;
    private SenseListenerClient client() { return new SenseListenerClient(getActivity() == null ? getContext() : getActivity()); }
    @Override public void load() {
        super.load(); client().attachProtectedPowerBridge(bridgeGeneration);
    }
    @Override protected void handleOnPause() {
        client().cancelProtectedPowerLaunch(); super.handleOnPause();
    }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        client().releaseInvocationBridge(bridgeGeneration);
        super.handleOnDestroy();
    }
    private JSObject statusReply(Bundle result) {
        JSObject out = new JSObject(); out.put("available", result != null);
        if (result == null && client().installation() == SenseListenerClient.Installation.ABSENT) {
            out.put("reason", "not-installed");
        }
        if (result != null) {
            out.put("state", result.getString("state", "OFF")); out.put("label", result.getString("label", ""));
            out.put("consented", result.getBoolean("consented", false)); out.put("listening", result.getBoolean("listening", false));
            out.put("microphoneOpen", result.getBoolean("microphoneOpen", false));
        }
        return out;
    }

    /** The provider can report OFF or a policy condition that takes precedence over user pause. */
    private static boolean pauseState(String state) {
        switch (state) {
            case "OFF":
            case "PERMISSION_REQUIRED":
            case "NOTIFICATIONS_REQUIRED":
            case "STOPPED_AFTER_ERRORS":
            case "STOPPED_INDICATOR_LOST":
            case "PAUSED_OTHER_USER":
            case "WAITING_FOR_UNLOCK":
            case "SPEECH_UNAVAILABLE":
            case "PAUSED_USER":
                return true;
            default:
                return false;
        }
    }

    private static JSObject unconfirmedStop() {
        JSObject out = new JSObject(); out.put("available", false); return out;
    }

    private JSObject stopReply(Bundle result, boolean turnOff) {
        if (result == null) return statusReply(null);
        if (!result.getBoolean("saved", false)
                || result.getBoolean("listening", true) || result.getBoolean("microphoneOpen", true)) {
            return unconfirmedStop();
        }
        String state = result.getString("state");
        if (state == null || !(turnOff ? "OFF".equals(state) : pauseState(state))) return unconfirmedStop();
        JSObject out = statusReply(result);
        out.put("saved", true);
        return out;
    }

    @PluginMethod public void status(PluginCall call) { call.resolve(statusReply(client().status())); }
    @PluginMethod public void pause(PluginCall call) { call.resolve(stopReply(client().pause(), false)); }
    @PluginMethod public void turnOff(PluginCall call) { call.resolve(stopReply(client().turnOff(), true)); }
    @PluginMethod public void openSettings(PluginCall call) {
        Intent intent = client().settingsIntent(); boolean opened = false;
        if (intent != null) try { getActivity().startActivity(intent); opened = true; } catch (RuntimeException unavailable) { }
        JSObject out = new JSObject(); out.put("opened", opened); call.resolve(out);
    }
    @PluginMethod public void bindInvocationSession(PluginCall call) {
        try {
            Integer generation = call.getInt("generation");
            if (!destroyed) client().bindInvocationSession(bridgeGeneration, generation == null ? 0 : generation, call.getString("bindingId"), call.getString("sessionKey"));
            call.resolve();
        }
        catch (IllegalArgumentException invalid) { call.reject(invalid.getMessage()); }
    }
    @PluginMethod public void discardProtectedPowerInvocation(PluginCall call) {
        Integer generation = call.getInt("generation");
        if (!destroyed) client().discardProtectedPowerInvocation(bridgeGeneration, generation == null ? 0 : generation,
                call.getString("bindingId"), call.getString("sessionKey"));
        call.resolve();
    }
    @PluginMethod public void claimProtectedPowerLaunch(PluginCall call) {
        Integer generation = call.getInt("generation");
        Bundle result = client().claimProtectedPowerLaunch(bridgeGeneration, generation == null ? 0 : generation,
                call.getString("bindingId"), call.getString("sessionKey"), call.getString("accountRef"),
                !destroyed && getActivity() != null && getActivity().hasWindowFocus() && !getActivity().isFinishing() && !getActivity().isDestroyed());
        JSObject out = new JSObject(); out.put("assistant", result.getBoolean("assistant")); out.put("invocation", result.getString("invocation")); out.put("locked", result.getBoolean("locked")); call.resolve(out);
    }
    @PluginMethod public void discardProtectedPowerLaunch(PluginCall call) {
        Integer generation = call.getInt("generation");
        client().discardProtectedPowerLaunch(bridgeGeneration, generation == null ? 0 : generation,
                call.getString("bindingId"), call.getString("sessionKey")); call.resolve();
    }
    @PluginMethod public void takeInvocation(PluginCall call) {
        Integer generation = call.getInt("generation");
        Bundle result=client().takeInvocation(bridgeGeneration, generation == null ? 0 : generation, call.getString("bindingId"), call.getString("sessionKey"), !destroyed && getActivity()!=null && getActivity().hasWindowFocus() && !getActivity().isFinishing() && !getActivity().isDestroyed());
        JSObject out=new JSObject();out.put("assistant",result.getBoolean("assistant"));out.put("invocation",result.getString("invocation"));out.put("locked",result.getBoolean("locked"));call.resolve(out);
    }
}

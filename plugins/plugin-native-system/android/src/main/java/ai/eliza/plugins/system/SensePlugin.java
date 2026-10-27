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
    @Override protected void handleOnDestroy() {
        destroyed = true;
        client().releaseInvocationBridge(bridgeGeneration);
        super.handleOnDestroy();
    }
    private void resolve(PluginCall call, Bundle result) {
        JSObject out = new JSObject(); out.put("available", result != null);
        if (result != null) {
            out.put("state", result.getString("state", "OFF")); out.put("label", result.getString("label", ""));
            out.put("consented", result.getBoolean("consented", false)); out.put("listening", result.getBoolean("listening", false));
            out.put("microphoneOpen", result.getBoolean("microphoneOpen", false));
        }
        call.resolve(out);
    }
    @PluginMethod public void status(PluginCall call) { resolve(call, client().status()); }
    @PluginMethod public void pause(PluginCall call) { resolve(call, client().pause()); }
    @PluginMethod public void turnOff(PluginCall call) { resolve(call, client().turnOff()); }
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
    @PluginMethod public void takeInvocation(PluginCall call) {
        Integer generation = call.getInt("generation");
        Bundle result=client().takeInvocation(bridgeGeneration, generation == null ? 0 : generation, call.getString("bindingId"), call.getString("sessionKey"), !destroyed && getActivity()!=null && getActivity().hasWindowFocus() && !getActivity().isFinishing() && !getActivity().isDestroyed());
        JSObject out=new JSObject();out.put("assistant",result.getBoolean("assistant"));out.put("invocation",result.getString("invocation"));out.put("locked",result.getBoolean("locked"));call.resolve(out);
    }
}

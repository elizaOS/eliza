/**
 * Capacitor boundary for Android native transcript surfaces. Renderer envelopes
 * are independently decoded/reduced, persisted app-privately, and published as
 * a native view-model event for activities, widgets, and diagnostics.
 */

package ai.elizaos.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeTranscript")
public class NativeTranscriptPlugin extends Plugin {
    private static final String PREFS = "eliza-native-transcript";
    private static final String VIEW_KEY = "viewModel";

    private final NativeTranscriptReducer reducer = new NativeTranscriptReducer();

    @PluginMethod
    public void publishStream(PluginCall call) {
        try {
            JsonObject envelope = JsonParser.parseString(call.getData().toString()).getAsJsonObject();
            NativeTranscriptReducer.ApplyResult result = reducer.applyEnvelope(envelope);
            JSObject response = response(result);
            boolean committed = preferences().edit()
                .putString(VIEW_KEY, result.view.toString())
                .commit();
            if (!committed) {
                call.reject("Could not persist native transcript view model");
                return;
            }
            notifyListeners("viewModel", response);
            call.resolve(response);
        } catch (IllegalArgumentException | IllegalStateException | JSONException error) {
            // error-policy:J1 Capacitor is the transport boundary; malformed
            // envelopes become an explicit rejected plugin call.
            call.reject("Could not apply native transcript stream", error);
        }
    }

    @PluginMethod
    public void readViewModel(PluginCall call) {
        try {
            String stored = preferences().getString(VIEW_KEY, null);
            JsonObject view = stored == null
                ? reducer.viewModel()
                : JsonParser.parseString(stored).getAsJsonObject();
            JSObject response = new JSObject();
            response.put("view", toJsObject(view));
            call.resolve(response);
        } catch (IllegalStateException | JSONException error) {
            // error-policy:J1 Capacitor read boundary translates corrupt native
            // persistence into an explicit rejection, never an empty view.
            call.reject("Could not read native transcript view model", error);
        }
    }

    private JSObject response(NativeTranscriptReducer.ApplyResult result) throws JSONException {
        JSArray rejected = new JSArray();
        for (int index : result.rejectedIndexes) rejected.put(index);
        JSObject response = new JSObject();
        response.put("view", toJsObject(result.view));
        response.put("rejectedIndexes", rejected);
        return response;
    }

    private static JSObject toJsObject(JsonObject value) throws JSONException {
        return JSObject.fromJSONObject(new JSONObject(value.toString()));
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

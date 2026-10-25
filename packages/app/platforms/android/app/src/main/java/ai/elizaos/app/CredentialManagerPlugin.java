/**
 * Opens the device password-manager setup screen without exposing vault contents
 * or provider authentication state to the renderer or agent.
 */
package ai.elizaos.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CredentialManager")
public class CredentialManagerPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(new Intent(getActivity(), PasswordsActivity.class));
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException error) {
                // error-policy:J1 Return a non-secret native navigation failure.
                call.reject("Could not open password settings.", "PASSWORD_SETTINGS_UNAVAILABLE");
            }
        });
    }
}

package ai.elizaos.app;

import android.Manifest;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.firebase.FirebaseApp;

/**
 * Firebase-guarded replacement for the community PushNotifications plugin.
 *
 * Sideload/local builds ship without google-services.json (the gradle build
 * only applies the google-services plugin when the file exists), so
 * FirebaseApp never initializes. The stock plugin's register() then throws
 * IllegalStateException from FirebaseMessaging.getInstance() ON THE
 * CapacitorPlugins HANDLER THREAD — which is a hard process crash ("Eliza
 * has stopped"), not a rejected JS promise. The renderer calls register()
 * whenever notification permission is already granted (see
 * packages/ui/src/state/notifications/push-registration.ts), so every
 * Firebase-less build died the moment the shell painted.
 *
 * This subclass rejects the call cleanly when no FirebaseApp exists and
 * defers to the stock behavior otherwise. MainActivity registers it directly
 * on the bridge AFTER super.onCreate(), which wins the plugin-name slot from
 * the auto-registered stock plugin (Bridge.registerPlugin is a plain
 * map.put — last registration wins).
 */
@CapacitorPlugin(
    name = "PushNotifications",
    permissions = @Permission(
        strings = { Manifest.permission.POST_NOTIFICATIONS },
        alias = "receive"
    )
)
public class SafePushNotificationsPlugin extends PushNotificationsPlugin {

    private boolean firebaseAvailable() {
        try {
            return !FirebaseApp.getApps(getContext()).isEmpty();
        } catch (RuntimeException error) {
            return false;
        }
    }

    @Override
    @PluginMethod
    public void register(PluginCall call) {
        if (!firebaseAvailable()) {
            call.reject(
                "push-unavailable: this build has no Firebase configuration (google-services.json absent)"
            );
            return;
        }
        super.register(call);
    }

    @Override
    @PluginMethod
    public void unregister(PluginCall call) {
        if (!firebaseAvailable()) {
            call.reject(
                "push-unavailable: this build has no Firebase configuration (google-services.json absent)"
            );
            return;
        }
        super.unregister(call);
    }
}

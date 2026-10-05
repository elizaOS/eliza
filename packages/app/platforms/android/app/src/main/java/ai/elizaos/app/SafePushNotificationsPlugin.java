package ai.elizaos.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.HashMap;
import java.util.Map;

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
 * defers to the stock behavior otherwise. MainActivity's initialPlugins list
 * appends it after discovery and before the first renderer header export.
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
            FirebaseMessaging.getInstance();
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    @PluginMethod
    public void getReminderDataCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("reminderDataNotifications", ElizaReminderMessagingService.isDeclaredHandler(getContext()));
        result.put("reminderChannelSelection", true);
        result.put("reminderPresentation", true);
        call.resolve(result);
    }

    @PluginMethod
    public void resolveReminderChannel(PluginCall call) {
        String priority = call.getString("priority");
        String ownerType = call.getString("ownerType");
        if ((!"occurrence".equals(ownerType) && !"calendar_event".equals(ownerType))
            || (!"urgent".equals(priority) && !"high".equals(priority)
                && !"normal".equals(priority) && !"low".equals(priority))) {
            call.reject("Invalid reminder channel request");
            return;
        }
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) {
            call.reject("Notification manager unavailable");
            return;
        }
        NotificationChannel selected = ElizaReminderMessagingService.resolveReminderChannel(manager, priority, ownerType);
        JSObject result = new JSObject();
        result.put("channelId", selected.getId());
        result.put("blocked", ElizaReminderMessagingService.isReminderChannelBlocked(manager, selected));
        call.resolve(result);
    }

    /** Foreground uses the same validated projection, groups, tap and receipt as FCM. */
    @PluginMethod
    public void presentReminderNotification(PluginCall call) {
        String ownerType = call.getString("ownerType");
        if (!"occurrence".equals(ownerType) && !"calendar_event".equals(ownerType)) {
            call.reject("Invalid reminder owner type");
            return;
        }
        if (call.getData().has("groupKey") && !(call.getData().opt("groupKey") instanceof String)) {
            call.reject("Invalid reminder group key");
            return;
        }
        Map<String, String> data = new HashMap<>();
        data.put("category", "reminder");
        for (String name : new String[]{"notificationId", "title", "body", "priority", "ownerType",
                "deepLink", "conversationId", "messageId", "groupKey"}) {
            String value = call.getString(name);
            if (value != null) data.put(name, value);
        }
        JSObject result = new JSObject();
        result.put("accepted", ElizaReminderMessagingService.projectReminder(
            getContext(), data, data.get("notificationId")));
        call.resolve(result);
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

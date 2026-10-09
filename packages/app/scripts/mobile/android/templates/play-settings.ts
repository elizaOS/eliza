/** Renders the Android play settings Java source for cloud-safe mobile builds. */

/** Permissionless bridge to this app's Android permission settings pages. */
export function cloudSafePlaySettingsPluginJava(androidPackage) {
  return `package ${androidPackage};

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ElizaPlaySettings")
public final class ElizaPlaySettingsPlugin extends Plugin {
    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        String permission = call.getString("permission", "app");
        Intent intent;
        if ("notifications".equals(permission)) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = appDetailsIntent();
        }
        openSettingsIntent(call, intent);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openSettingsIntent(call, appDetailsIntent());
    }

    private Intent appDetailsIntent() {
        return new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName()));
    }

    private void openSettingsIntent(PluginCall call, Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Android app settings could not be opened.", "APP_SETTINGS_UNAVAILABLE", error);
        }
    }
}
`;
}

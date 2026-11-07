package ai.eliza.plugins.system;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

/**
 * Allowlisted Android settings pages a settings surface may hand off to. Each name maps to the
 * specific page first and, where images lack it, a broader page; the caller learns which one
 * opened, so it never claims the specific page when only the broader one exists. Handing off
 * changes nothing: the owner decides on Android's own page.
 */
public final class SystemSettingsPages {
    private SystemSettingsPages() {}

    /** Names a renderer may request. */
    public static final String[] PAGES = {
        "accounts", "wifi", "bluetooth", "mobile", "airplane", "location", "display", "sound", "battery",
        "about", "developer", "notifications", "privacy", "default-apps", "dnd",
    };

    /** Android pages tried in order for one allowlisted name; null for anything else. */
    public static String[] actions(String page) {
        if (page == null) return null;
        switch (page) {
            case "accounts": return new String[] {Settings.ACTION_SYNC_SETTINGS};
            case "wifi": return new String[] {Settings.ACTION_WIFI_SETTINGS};
            case "bluetooth": return new String[] {Settings.ACTION_BLUETOOTH_SETTINGS};
            // The mobile network page; images without it fall back to Network & internet.
            case "mobile": return new String[] {Settings.ACTION_DATA_ROAMING_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS};
            case "airplane": return new String[] {Settings.ACTION_AIRPLANE_MODE_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS};
            case "location": return new String[] {Settings.ACTION_LOCATION_SOURCE_SETTINGS};
            case "display": return new String[] {Settings.ACTION_DISPLAY_SETTINGS};
            case "sound": return new String[] {Settings.ACTION_SOUND_SETTINGS};
            case "battery": return new String[] {Settings.ACTION_BATTERY_SAVER_SETTINGS};
            case "about": return new String[] {Settings.ACTION_DEVICE_INFO_SETTINGS};
            case "developer": return new String[] {Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS};
            case "notifications": return new String[] {Settings.ACTION_APP_NOTIFICATION_SETTINGS};
            case "privacy": return new String[] {Settings.ACTION_APPLICATION_DETAILS_SETTINGS};
            case "default-apps": return new String[] {Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS};
            // Do not disturb: the platform Zen mode page, then the public priority-mode page.
            case "dnd": return new String[] {"android.settings.ZEN_MODE_SETTINGS", Settings.ACTION_ZEN_MODE_PRIORITY_SETTINGS};
            default: return null;
        }
    }

    /** Starts one candidate page; throws when Android cannot open it. */
    public interface Launcher {
        void start(Intent intent);
    }

    /**
     * Opens the first candidate that starts. Per-app pages carry this package. Returns the index of
     * the page that opened (0 is the specific page), or -1 when none opened.
     *
     * @throws IllegalArgumentException for a name outside {@link #PAGES}
     */
    public static int open(String page, String packageName, Launcher launcher) {
        String[] candidates = actions(page);
        if (candidates == null) throw new IllegalArgumentException("Unsupported settings page");
        for (int index = 0; index < candidates.length; index++) {
            Intent intent = new Intent(candidates[index]);
            if (page.equals("privacy")) intent.setData(Uri.parse("package:" + packageName));
            if (page.equals("notifications")) intent.putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
            try {
                launcher.start(intent);
                return index;
            } catch (RuntimeException unavailable) {
                // Try the next allowlisted page.
            }
        }
        return -1;
    }
}

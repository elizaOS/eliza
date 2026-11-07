package ai.eliza.plugins.system;

import android.content.Context;
import android.content.pm.PackageManager;

/**
 * Asks Android to expand its own notification shade, as stock launchers do.
 *
 * <p>Android's shade stays the one notification and quick-settings surface; a launcher only asks
 * it to open, for example from a downward pull on empty Home. An ordinary (non-launcher) app never
 * asks. Android has no public SDK call for this: launchers use
 * StatusBarManager.expandNotificationsPanel, which needs the install-time EXPAND_STATUS_BAR
 * permission (declare it only in a launcher manifest) and is reached by reflection because the
 * method is not in the public SDK. Every way this can fail is an outcome, never thrown and never
 * reported as opened, so the renderer can show a fallback: Android's own top-edge swipe always
 * opens the shade. {@link #OPENED} means Android accepted the call, not that the shade is visible.
 */
public final class SystemShade {
    private SystemShade() {}

    public static final String PERMISSION = "android.permission.EXPAND_STATUS_BAR";
    /** Android accepted the request to expand its notification shade. */
    public static final String OPENED = "opened";
    /** The host is not acting as a launcher, so it follows ordinary app behaviour and does not ask. */
    public static final String STANDALONE = "standalone";
    /** The launcher was installed without EXPAND_STATUS_BAR. */
    public static final String PERMISSION_MISSING = "permission-missing";
    /** This Android build has no status bar service or refused the call. */
    public static final String UNSUPPORTED = "unsupported";
    /** The host window is not in front, so a pull or button there cannot have asked. */
    public static final String NOT_IN_FRONT = "not-in-front";

    /** The status bar service Android registers under Context.STATUS_BAR_SERVICE (a hidden constant). */
    public static final String STATUS_BAR_SERVICE = "statusbar";

    /** Small seam so the outcome mapping can be exercised without a device. */
    public interface Platform {
        boolean granted(String permission);
        Object statusBar();
    }

    public static String expand(Context context, boolean launcher) {
        return expand(new Platform() {
            @Override public boolean granted(String permission) { return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
            // The service name is a hidden Android constant; absence is handled as unsupported.
            @android.annotation.SuppressLint("WrongConstant")
            @Override public Object statusBar() { return context.getSystemService(STATUS_BAR_SERVICE); }
        }, launcher);
    }

    public static String expand(Platform platform, boolean launcher) {
        if (!launcher) return STANDALONE;
        if (!platform.granted(PERMISSION)) return PERMISSION_MISSING;
        Object service;
        try {
            service = platform.statusBar();
        } catch (RuntimeException unavailable) {
            return UNSUPPORTED;
        }
        if (service == null) return UNSUPPORTED;
        try {
            service.getClass().getMethod("expandNotificationsPanel").invoke(service);
            return OPENED;
        } catch (ReflectiveOperationException | RuntimeException refused) {
            // NoSuchMethodException on a build without the method, InvocationTargetException wrapping a
            // SecurityException when Android refuses it, or a hidden-API restriction.
            android.util.Log.w("ElizaShade", "Android did not expand its notification shade: " + refused.getClass().getSimpleName());
            return UNSUPPORTED;
        }
    }
}

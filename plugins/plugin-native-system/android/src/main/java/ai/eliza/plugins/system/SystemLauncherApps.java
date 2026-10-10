package ai.eliza.plugins.system;

import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Host-independent launcher discovery under Android's package-visibility rules. */
public final class SystemLauncherApps {
    private SystemLauncherApps() {}

    public static final class App {
        public final String packageName;
        public final String label;

        private App(String packageName, String label) {
            this.packageName = packageName;
            this.label = label;
        }
    }

    public static List<App> list(Context context) {
        PackageManager packages = context.getPackageManager();
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        return describe(packages, packages.queryIntentActivities(query, 0), context.getPackageName());
    }

    static List<App> describe(PackageManager packages, List<ResolveInfo> candidates, String self) {
        List<ResolveInfo> activities = eligible(candidates, self);
        activities.sort(new ResolveInfo.DisplayNameComparator(packages));
        Set<String> seen = new HashSet<>();
        List<App> apps = new ArrayList<>();
        for (ResolveInfo activity : activities) {
            String name = activity.activityInfo.packageName;
            if (seen.add(name)) {
                CharSequence label = activity.loadLabel(packages);
                apps.add(new App(name, label == null ? name : label.toString()));
            }
        }
        return apps;
    }

    static List<ResolveInfo> eligible(List<ResolveInfo> activities, String self) {
        List<ResolveInfo> result = new ArrayList<>();
        for (ResolveInfo item : activities) {
            ActivityInfo activity = item == null ? null : item.activityInfo;
            if (activity != null && activity.exported && activity.enabled &&
                activity.applicationInfo != null && activity.applicationInfo.enabled &&
                activity.packageName != null && activity.name != null && !activity.name.isEmpty() &&
                !activity.packageName.equals(self)) {
                result.add(item);
            }
        }
        return result;
    }

    /** Resolve only; the host owns the foreground/user-intent check and launch. */
    public static Intent launchIntent(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty() ||
            packageName.equals(context.getPackageName())) {
            throw new IllegalArgumentException("Choose an installed app");
        }
        PackageManager packages = context.getPackageManager();
        Intent intent = packages.getLaunchIntentForPackage(packageName);
        if (intent == null) return null;
        ResolveInfo resolved = packages.resolveActivity(intent, 0);
        if (eligible(java.util.Collections.singletonList(resolved), context.getPackageName()).isEmpty() ||
            !packageName.equals(resolved.activityInfo.packageName)) return null;
        return intent;
    }

    /** Default-handler roles a launcher hands off to; the intents carry no user data. */
    public static Intent roleIntent(String role) {
        if ("dial".equals(role)) return SystemAppIntents.phone().setData(Uri.parse("tel:"));
        return null;
    }

    /** Resolution result: a chooser (several handlers, none preferred) is available with no package. */
    public static final class DefaultHandler {
        public final boolean available;
        public final String packageName;
        public final String label;

        DefaultHandler(boolean available, String packageName, String label) {
            this.available = available;
            this.packageName = packageName;
            this.label = label;
        }
    }

    /** Resolve only; the host owns the user-intent check and the launch. The host never counts as
     * its own handler. Unknown roles are refused. */
    public static DefaultHandler resolveDefault(Context context, String role) {
        Intent intent = roleIntent(role);
        if (intent == null) throw new IllegalArgumentException("Choose a supported default app");
        return resolveDefault(context.getPackageManager(), intent, context.getPackageName());
    }

    static DefaultHandler resolveDefault(PackageManager packages, Intent intent, String self) {
        ResolveInfo preferred = packages.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
        List<ResolveInfo> all = packages.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
        return chooseDefault(preferred, all, self, preferred == null ? null : preferred.loadLabel(packages));
    }

    static DefaultHandler chooseDefault(ResolveInfo preferred, List<ResolveInfo> all, String self, CharSequence label) {
        List<ResolveInfo> handlers = eligible(all, self);
        if (handlers.isEmpty()) return new DefaultHandler(false, null, null);
        for (ResolveInfo item : handlers) {
            if (sameActivity(preferred, item)) {
                String name = item.activityInfo.packageName;
                return new DefaultHandler(true, name, label == null ? name : label.toString());
            }
        }
        return new DefaultHandler(true, null, null);
    }

    private static boolean sameActivity(ResolveInfo first, ResolveInfo second) {
        return first != null && first.activityInfo != null &&
            java.util.Objects.equals(first.activityInfo.packageName, second.activityInfo.packageName) &&
            java.util.Objects.equals(first.activityInfo.name, second.activityInfo.name);
    }

    /** Resolve an explicit destination, or a chooser containing only eligible non-host activities. */
    public static Intent defaultLaunchIntent(Context context, String role) {
        Intent intent = roleIntent(role);
        if (intent == null) throw new IllegalArgumentException("Choose a supported default app");
        PackageManager packages = context.getPackageManager();
        return chooseLaunchIntent(intent, packages.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY),
            packages.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY), context.getPackageName());
    }

    static Intent chooseLaunchIntent(Intent intent, ResolveInfo preferred, List<ResolveInfo> all, String self) {
        List<ResolveInfo> handlers = eligible(all, self);
        List<Intent> choices = new ArrayList<>();
        Set<ComponentName> seen = new HashSet<>();
        for (ResolveInfo handler : handlers) {
            ActivityInfo activity = handler.activityInfo;
            ComponentName component = new ComponentName(activity.packageName, activity.name);
            Intent choice = new Intent(intent).setComponent(component);
            if (sameActivity(preferred, handler)) return choice;
            if (seen.add(component)) choices.add(choice);
        }
        if (choices.isEmpty()) return null;
        if (choices.size() == 1) return choices.get(0);
        Intent chooser = Intent.createChooser(choices.remove(0), null);
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, choices.toArray(new Intent[0]));
        return chooser;
    }

    /** The package's launcher icon as a square PNG, or null when it cannot be rendered. */
    public static byte[] iconPng(PackageManager packages, String packageName, int size) {
        if (packageName == null || packageName.isEmpty() || size < 16 || size > 512) return null;
        Bitmap bitmap = null;
        try {
            Drawable drawable = packages.getApplicationIcon(packageName);
            bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(new Canvas(bitmap));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            boolean written = bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            return written ? out.toByteArray() : null;
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }
}

package ai.eliza.plugins.system;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
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
                activity.packageName != null && !activity.packageName.equals(self)) {
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
}

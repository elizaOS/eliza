package ai.eliza.plugins.system;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.UserHandle;
import android.os.UserManager;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Host-independent launcher discovery under Android's package-visibility rules.
 *
 * <p>An entry is one launcher activity, identified by package, activity class and Android user,
 * never by its label. The current user's entries come from the package manager under the host's
 * MAIN/LAUNCHER visibility query; other profiles (work, private, clone) come from
 * {@link LauncherApps}. Listing never launches. {@link #resolve} re-resolves the exact component
 * at launch time, so an entry from an older list that was removed, disabled or locked is refused
 * with a stable reason instead of opening something else. */
public final class SystemLauncherApps {
    private SystemLauncherApps() {}

    public static final String NOT_INSTALLED = "not-installed";
    public static final String DISABLED = "disabled";
    public static final String NO_LAUNCHER = "no-launcher";
    public static final String PROFILE_LOCKED = "profile-locked";
    public static final String PROFILE_UNAVAILABLE = "profile-unavailable";
    /** Android refused the read or the start itself; distinct from every refusal above. */
    public static final String FAILED = "failed";
    /** The stand-in LauncherApps lists for an app with no launcher activity. It opens Android's
     * app details, not the app, so it is never an entry. */
    static final String APP_DETAILS_ACTIVITY = "android.app.AppDetailsActivity";

    public static final class App {
        public final String packageName;
        public final String activityName;
        public final String label;
        /** Android user serial of another profile; null for the current user. */
        public final String user;
        /** "work", "private", "clone" or "other" for another profile; null for the current user. */
        public final String profile;
        /** The profile is paused or not unlocked, so its apps cannot run now. */
        public final boolean locked;
        /** The ResolveInfo or LauncherActivityInfo this entry was read from; used for its icon. */
        private final Object source;

        App(String packageName, String activityName, String label, String user, String profile,
            boolean locked, Object source) {
            this.packageName = packageName;
            this.activityName = activityName;
            this.label = label;
            this.user = user;
            this.profile = profile;
            this.locked = locked;
            this.source = source;
        }

        /** Stable identity: package, activity and user. */
        public String key() {
            return packageName + "/" + activityName + (user == null ? "" : "#" + user);
        }

        /** This activity's own icon (badged for another profile), or null when Android has none. */
        public Drawable icon(PackageManager packages) {
            try {
                if (source instanceof LauncherActivityInfo) return ((LauncherActivityInfo) source).getBadgedIcon(0);
                if (source instanceof ResolveInfo) return ((ResolveInfo) source).loadIcon(packages);
            } catch (RuntimeException error) {
                return null;
            }
            return null;
        }
    }

    /** A refused launch. {@code code} is stable for callers; the message can be shown to the user. */
    public static final class Refusal extends Exception {
        private static final long serialVersionUID = 1L;
        public final String code;

        Refusal(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** A resolved launch target. {@code user} is null for the current user. */
    public static final class Target {
        public final ComponentName component;
        public final UserHandle user;

        Target(ComponentName component, UserHandle user) {
            this.component = component;
            this.user = user;
        }
    }

    static Intent launcherQuery() {
        return new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
    }

    /** Every launcher entry visible to the host: the current user's, then each other profile's. */
    public static List<App> list(Context context) {
        PackageManager packages = context.getPackageManager();
        String self = context.getPackageName();
        List<App> apps = describe(packages, packages.queryIntentActivities(launcherQuery(), 0), self);
        LauncherApps launcher = context.getSystemService(LauncherApps.class);
        UserManager users = context.getSystemService(UserManager.class);
        if (launcher == null || users == null) return apps;
        List<UserHandle> profiles;
        try {
            profiles = launcher.getProfiles();
        } catch (RuntimeException error) {
            return apps;
        }
        Set<String> seen = new HashSet<>();
        for (UserHandle user : profiles) {
            if (user == null || user.equals(Process.myUserHandle())) continue;
            String serial = Long.toString(users.getSerialNumberForUser(user));
            String profile = profileKind(launcher, user);
            boolean locked = locked(users, user);
            List<LauncherActivityInfo> activities;
            // A profile Android will not describe to this app adds nothing; the list does not fail.
            try {
                activities = launcher.getActivityList(null, user);
            } catch (RuntimeException error) {
                continue;
            }
            if (activities == null) continue;
            List<App> entries = new ArrayList<>();
            for (LauncherActivityInfo activity : activities) {
                ComponentName component = activity == null ? null : activity.getComponentName();
                if (!listable(component, self)) continue;
                App app = new App(component.getPackageName(), component.getClassName(),
                    text(activity.getLabel(), component.getPackageName()), serial, profile, locked, activity);
                if (seen.add(app.key())) entries.add(app);
            }
            entries.sort((a, b) -> a.label.compareToIgnoreCase(b.label));
            apps.addAll(entries);
        }
        return apps;
    }

    /** Current-user entries, one per distinct launcher activity, sorted by label. */
    static List<App> describe(PackageManager packages, List<ResolveInfo> candidates, String self) {
        List<ResolveInfo> activities = eligible(candidates, self);
        activities.sort(new ResolveInfo.DisplayNameComparator(packages));
        Set<String> seen = new HashSet<>();
        List<App> apps = new ArrayList<>();
        for (ResolveInfo activity : activities) {
            ActivityInfo info = activity.activityInfo;
            App app = new App(info.packageName, info.name, text(activity.loadLabel(packages), info.packageName),
                null, null, false, activity);
            if (seen.add(app.key())) apps.add(app);
        }
        return apps;
    }

    static List<ResolveInfo> eligible(List<ResolveInfo> activities, String self) {
        List<ResolveInfo> result = new ArrayList<>();
        if (activities == null) return result;
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

    /** A real launcher activity of another app: not the host's own copy in a profile, and not
     * Android's app-details stand-in. */
    static boolean listable(ComponentName component, String self) {
        return component != null && !component.getPackageName().equals(self) &&
            !APP_DETAILS_ACTIVITY.equals(component.getClassName());
    }

    static String text(CharSequence label, String fallback) {
        String value = label == null ? "" : label.toString().trim();
        return value.isEmpty() ? fallback : value;
    }

    /** A profile in quiet mode ("work apps paused") or not yet unlocked cannot run its apps. */
    static boolean locked(UserManager users, UserHandle user) {
        try {
            return users.isQuietModeEnabled(user) || !users.isUserUnlocked(user);
        } catch (RuntimeException error) {
            return true;
        }
    }

    static String profileKind(LauncherApps launcher, UserHandle user) {
        if (Build.VERSION.SDK_INT >= 35) {
            try {
                android.content.pm.LauncherUserInfo info = launcher.getLauncherUserInfo(user);
                return info == null ? "other" : profileKind(info.getUserType());
            } catch (RuntimeException error) {
                return "other";
            }
        }
        // Before Android 15 the profile type is not public; a managed (work) profile is the documented case.
        return "work";
    }

    static String profileKind(String userType) {
        if ("android.os.usertype.profile.MANAGED".equals(userType)) return "work";
        if ("android.os.usertype.profile.PRIVATE".equals(userType)) return "private";
        if ("android.os.usertype.profile.CLONE".equals(userType)) return "clone";
        return "other";
    }

    /** The entry in {@code apps} that names this package, activity and user, or null. */
    public static App find(List<App> apps, String packageName, String activityName, String user) {
        for (App app : apps) {
            if (app.packageName.equals(packageName) && app.activityName.equals(activityName) &&
                java.util.Objects.equals(app.user, user)) return app;
        }
        return null;
    }

    /** Why the current user cannot open this package's launcher activity now. */
    public static Refusal explain(PackageManager packages, String packageName) {
        ApplicationInfo application;
        try {
            application = packages.getApplicationInfo(packageName, 0);
        } catch (PackageManager.NameNotFoundException error) {
            return new Refusal(NOT_INSTALLED, "This app is no longer installed.");
        }
        if (!application.enabled) {
            return new Refusal(DISABLED, "This app is disabled. Enable it in Android settings to open it.");
        }
        return new Refusal(NO_LAUNCHER, "This app has no screen that can be opened from here.");
    }

    /** Resolves the exact listed component now. Never launches; the host owns the user-intent
     * check and calls {@link #launchIntent(ComponentName)} or {@link LauncherApps#startMainActivity}. */
    public static Target resolve(Context context, String packageName, String activityName, String user)
        throws Refusal {
        String self = context.getPackageName();
        if (packageName == null || packageName.isEmpty() || packageName.equals(self) ||
            activityName == null || activityName.isEmpty()) {
            throw new IllegalArgumentException("Choose an installed app");
        }
        if (APP_DETAILS_ACTIVITY.equals(activityName)) {
            throw new Refusal(NO_LAUNCHER, "This app has no screen that can be opened from here.");
        }
        PackageManager packages = context.getPackageManager();
        if (user == null) {
            List<App> current = describe(packages,
                packages.queryIntentActivities(launcherQuery().setPackage(packageName), 0), self);
            if (find(current, packageName, activityName, null) == null) throw explain(packages, packageName);
            return new Target(new ComponentName(packageName, activityName), null);
        }
        long serial;
        try {
            serial = Long.parseLong(user);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Choose an installed app");
        }
        LauncherApps launcher = context.getSystemService(LauncherApps.class);
        UserManager users = context.getSystemService(UserManager.class);
        UserHandle handle = users == null ? null : users.getUserForSerialNumber(serial);
        if (launcher == null || handle == null || handle.equals(Process.myUserHandle()) ||
            !launcher.getProfiles().contains(handle)) {
            throw new Refusal(PROFILE_UNAVAILABLE, "This profile is no longer on the phone.");
        }
        if (locked(users, handle)) throw new Refusal(PROFILE_LOCKED, lockedMessage(profileKind(launcher, handle)));
        ComponentName component = new ComponentName(packageName, activityName);
        List<LauncherActivityInfo> activities;
        try {
            activities = launcher.getActivityList(packageName, handle);
        } catch (RuntimeException error) {
            activities = Collections.emptyList();
        }
        if (activities != null) {
            for (LauncherActivityInfo activity : activities) {
                if (activity != null && component.equals(activity.getComponentName())) {
                    return new Target(component, handle);
                }
            }
        }
        throw new Refusal(NOT_INSTALLED, "This app is no longer available in that profile.");
    }

    static String lockedMessage(String profile) {
        if ("work".equals(profile)) return "Work apps are paused or locked. Turn on work apps in Android, then try again.";
        if ("private".equals(profile)) return "Private space is locked. Unlock it in Android, then try again.";
        return "This profile is paused or locked. Unlock it in Android, then try again.";
    }

    /** The explicit current-user launch intent for one resolved component. */
    public static Intent launchIntent(ComponentName component) {
        return launcherQuery().setComponent(component)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
    }

    /** Resolve only, by package; the host owns the foreground/user-intent check and launch.
     * Prefer {@link #resolve} with the listed activity and user. */
    public static Intent launchIntent(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty() ||
            packageName.equals(context.getPackageName())) {
            throw new IllegalArgumentException("Choose an installed app");
        }
        PackageManager packages = context.getPackageManager();
        Intent intent = packages.getLaunchIntentForPackage(packageName);
        if (intent == null) return null;
        ResolveInfo resolved = packages.resolveActivity(intent, 0);
        if (eligible(Collections.singletonList(resolved), context.getPackageName()).isEmpty() ||
            !packageName.equals(resolved.activityInfo.packageName)) return null;
        return intent;
    }

    /** Called when an install, removal, update, enable, disable, suspension or profile change may
     * have changed the list. {@code packageName} is null when several packages or a profile changed. */
    public interface ChangeListener {
        void changed(String packageName, String reason);
    }

    /** Profile broadcasts by action name: several constants are newer than the minimum SDK. */
    static final String[] PROFILE_ACTIONS = {
        Intent.ACTION_MANAGED_PROFILE_AVAILABLE, Intent.ACTION_MANAGED_PROFILE_UNAVAILABLE,
        Intent.ACTION_MANAGED_PROFILE_UNLOCKED, Intent.ACTION_MANAGED_PROFILE_ADDED,
        Intent.ACTION_MANAGED_PROFILE_REMOVED,
        "android.intent.action.PROFILE_ACCESSIBLE", "android.intent.action.PROFILE_INACCESSIBLE",
        "android.intent.action.PROFILE_ADDED", "android.intent.action.PROFILE_REMOVED",
        "android.intent.action.PROFILE_AVAILABLE", "android.intent.action.PROFILE_UNAVAILABLE",
    };

    /** Watches for changes outside the host on the main thread. Close the result to stop. The
     * host re-reads {@link #list} itself; no inventory is pushed. Changes to the host itself are
     * not reported. */
    public static AutoCloseable watch(Context context, ChangeListener listener) {
        java.util.Objects.requireNonNull(listener);
        Context application = context.getApplicationContext() == null ? context : context.getApplicationContext();
        String self = application.getPackageName();
        LauncherApps launcher = application.getSystemService(LauncherApps.class);
        LauncherApps.Callback callback = null;
        if (launcher != null) {
            callback = new LauncherApps.Callback() {
                private void report(String name, String reason) {
                    if (name == null || !name.equals(self)) listener.changed(name, reason);
                }
                @Override public void onPackageRemoved(String name, UserHandle user) { report(name, "removed"); }
                @Override public void onPackageAdded(String name, UserHandle user) { report(name, "added"); }
                @Override public void onPackageChanged(String name, UserHandle user) { report(name, "changed"); }
                @Override public void onPackagesAvailable(String[] names, UserHandle user, boolean replacing) { report(null, "available"); }
                @Override public void onPackagesUnavailable(String[] names, UserHandle user, boolean replacing) { report(null, "unavailable"); }
                @Override public void onPackagesSuspended(String[] names, UserHandle user) { report(null, "suspended"); }
                @Override public void onPackagesUnsuspended(String[] names, UserHandle user) { report(null, "unsuspended"); }
            };
            try {
                launcher.registerCallback(callback, new Handler(Looper.getMainLooper()));
            } catch (RuntimeException error) {
                callback = null;
            }
        }
        IntentFilter filter = new IntentFilter();
        for (String action : PROFILE_ACTIONS) filter.addAction(action);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) { listener.changed(null, "profile"); }
        };
        try {
            // System profile broadcasts only; no other app can send to this receiver.
            if (Build.VERSION.SDK_INT >= 33) application.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            else application.registerReceiver(receiver, filter);
        } catch (RuntimeException error) {
            receiver = null;
        }
        final LauncherApps.Callback registered = callback;
        final BroadcastReceiver profiles = receiver;
        return () -> {
            if (launcher != null && registered != null) {
                try { launcher.unregisterCallback(registered); } catch (RuntimeException ignored) { /* Already gone. */ }
            }
            if (profiles != null) {
                try { application.unregisterReceiver(profiles); } catch (RuntimeException ignored) { /* Already gone. */ }
            }
        };
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
        if (packageName == null || packageName.isEmpty()) return null;
        try {
            return iconPng(packages.getApplicationIcon(packageName), size);
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            return null;
        }
    }

    /** One listed entry's own icon (badged for another profile) as a square PNG, or null. */
    public static byte[] iconPng(PackageManager packages, App app, int size) {
        return app == null ? null : iconPng(app.icon(packages), size);
    }

    static byte[] iconPng(Drawable drawable, int size) {
        if (drawable == null || size < 16 || size > 512) return null;
        Bitmap bitmap = null;
        try {
            bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(new Canvas(bitmap));
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            boolean written = bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            return written ? out.toByteArray() : null;
        } catch (RuntimeException error) {
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }
}

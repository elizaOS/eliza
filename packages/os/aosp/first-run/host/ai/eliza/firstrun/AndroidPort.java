// spec/os/image/firstRun.md, "An attempt assigns only a role it read as empty or as a stock default, and retires at an owner's choice"; spec/os/image/firstRun.md, "An attempt begins only where the image enables first run, and is skipped unless the user is the unmanaged main system user"
package ai.eliza.firstrun;

import android.app.admin.DevicePolicyManager;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Process;
import android.os.UserHandle;
import android.os.UserManager;
import android.util.Log;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

final class AndroidPort implements FirstRunPolicy.Port {
    static final String TAG = "ElizaFirstRun";
    private static final String STATE = "state";
    private static final long ASSIGN_WITHIN_SECONDS = 10;

    private final Context context;
    private final UserHandle user = Process.myUserHandle();
    private final RoleManager roles;
    private final PackageManager packages;
    private final SharedPreferences stored;

    AndroidPort(Context context) {
        this.context = context;
        roles = context.getSystemService(RoleManager.class);
        packages = context.getPackageManager();
        stored = context.createDeviceProtectedStorageContext().getSharedPreferences("first_run", Context.MODE_PRIVATE);
    }

    @Override public FirstRunPolicy.Device device() {
        UserManager users = context.getSystemService(UserManager.class);
        DevicePolicyManager policy = context.getSystemService(DevicePolicyManager.class);
        return new FirstRunPolicy.Device(UserHandle.SYSTEM.equals(user), users.isMainUser(),
                policy.getDeviceOwnerComponentOnCallingUser() != null, users.isProfile(),
                packages.hasSystemFeature(PackageManager.FEATURE_TELEPHONY));
    }

    @Override public boolean available(FirstRunPolicy.Role role) {
        return roles.isRoleAvailable(role.android);
    }

    @Override public List<String> holders(FirstRunPolicy.Role role) {
        try {
            return roles.getRoleHoldersAsUser(role.android, user);
        } catch (RuntimeException unreadable) {
            Log.w(TAG, "role holders unreadable role=" + role.item, unreadable);
            return null;
        }
    }

    private ApplicationInfo installed(String packageName) {
        try {
            return packages.getApplicationInfo(packageName, 0);
        } catch (PackageManager.NameNotFoundException missing) {
            return null;
        }
    }

    @Override public boolean enabledInImage(String packageName) {
        ApplicationInfo app = installed(packageName);
        return app != null && app.enabled && (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && (app.flags & ApplicationInfo.FLAG_SUSPENDED) == 0;
    }

    @Override public boolean shippedByImage(String packageName) {
        ApplicationInfo app = installed(packageName);
        return app != null && (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
    }

    @Override public FirstRunPolicy.State load() {
        return FirstRunPolicy.decode(stored.getString(STATE, null));
    }

    @Override public boolean save(FirstRunPolicy.State state) {
        String encoded = FirstRunPolicy.encode(state);
        return stored.edit().putString(STATE, encoded).commit() && encoded.equals(stored.getString(STATE, null));
    }

    @Override public boolean assign(FirstRunPolicy.Role role, String packageName) {
        CompletableFuture<Boolean> done = new CompletableFuture<>();
        try {
            roles.addRoleHolderAsUser(role.android, packageName, 0, user, context.getMainExecutor(), done::complete);
            return done.get(ASSIGN_WITHIN_SECONDS, TimeUnit.SECONDS);
        } catch (RuntimeException | ExecutionException | TimeoutException refused) {
            Log.w(TAG, "role assignment not confirmed role=" + role.item + " package=" + packageName, refused);
            return false;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}

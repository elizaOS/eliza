package ai.eliza.plugins.system;

import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Nonprivileged access to the same-signer image listener. No enable/resume surface exists. */
public final class SenseListenerClient {
    public static final String SETTINGS_ACTIVITY = "ai.eliza.sense.SETTINGS_ACTIVITY";
    private static final Map<String, SenseInvocation> invocations = new HashMap<>();
    private static final AtomicLong bridgeGenerations = new AtomicLong();
    public static long nextInvocationBridge() { return bridgeGenerations.incrementAndGet(); }
    private final Context context;
    private final String packageName;

    public SenseListenerClient(Context context) {
        Context app = context.getApplicationContext();
        this.context = app == null ? context : app;
        this.packageName = context.getPackageName() + ".sense";
    }

    public boolean available() {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(packageName, 0);
            return info.enabled && context.getPackageManager().checkSignatures(context.getPackageName(), packageName) == PackageManager.SIGNATURE_MATCH
                    && context.checkSelfPermission(packageName + ".permission.LISTENER_CONTROL") == PackageManager.PERMISSION_GRANTED;
        } catch (PackageManager.NameNotFoundException | RuntimeException unavailable) { return false; }
    }

    private Bundle control(String method) {
        if (!available()) return null;
        try { return context.getContentResolver().call(Uri.parse("content://" + packageName + ".control"), method, null, null); }
        catch (RuntimeException unavailable) { return null; }
    }

    public Bundle status() { return control("status"); }
    public Bundle pause() { return control("pause"); }
    public Bundle turnOff() { return control("turnOff"); }

    /** Absent is safe to reset; an installed unacknowledged listener must stop the reset. */
    public boolean resetForData() {
        invocation().reset();
        try { context.getPackageManager().getApplicationInfo(packageName, 0); }
        catch (PackageManager.NameNotFoundException absent) { return true; }
        catch (RuntimeException unavailable) { return false; }
        Bundle result = control("reset");
        return result != null && result.getBoolean("saved", false) && !result.getBoolean("consented", true)
                && !result.getBoolean("listening", true);
    }

    /** Only a typed, exported activity inside the admitted package may be opened. */
    public Intent settingsIntent() {
        if (!available()) return null;
        try {
            PackageManager packages = context.getPackageManager();
            ApplicationInfo app = packages.getApplicationInfo(packageName, PackageManager.GET_META_DATA);
            String name = app.metaData == null ? null : app.metaData.getString(SETTINGS_ACTIVITY);
            if (name == null || !name.matches("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+")) return null;
            ComponentName component = new ComponentName(packageName, name);
            ActivityInfo activity = packages.getActivityInfo(component, 0);
            if (!name.equals(activity.name) || !activity.exported || !activity.enabled || activity.applicationInfo == null || !activity.applicationInfo.enabled
                    || activity.applicationInfo.uid != app.uid || !packageName.equals(activity.packageName)) return null;
            return new Intent().setComponent(component);
        } catch (PackageManager.NameNotFoundException | RuntimeException unavailable) { return null; }
    }

    private SenseInvocation invocation() {
        synchronized (invocations) { return invocations.computeIfAbsent(context.getPackageName(), ignored -> new SenseInvocation()); }
    }

    public void bindInvocationSession(long bridge, int generation, String bindingId, String session) { invocation().bind(bridge, generation, bindingId, session, SystemClock.elapsedRealtime()); }

    /**
     * Registers the host's native owner admission for this host package: the non-secret identity of
     * the owner whose authenticated session may claim a wake that arrived before the renderer bound
     * one. Call it from native startup (before the assistant activity records an invocation); null
     * removes it. Without it a cold wake only opens the assistant.
     */
    public void admitOwner(SenseInvocation.OwnerAdmission admission) { invocation().admit(admission); }
    public void releaseInvocationBridge(long bridge) { invocation().release(bridge); }

    /** Caller package must come from Android's Activity caller API, never an extra or deep link. */
    public void recordInvocation(String callerPackage) {
        boolean sameSigner = false;
        try { sameSigner = callerPackage != null && context.getPackageManager().checkSignatures(context.getPackageName(), callerPackage) == PackageManager.SIGNATURE_MATCH; } catch (RuntimeException unavailable) { }
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        invocation().record(context.getPackageName(), callerPackage, sameSigner, SystemClock.elapsedRealtime(), keyguard == null || keyguard.isKeyguardLocked());
    }

    public Bundle takeInvocation(long bridge, int generation, String bindingId, String session, boolean foreground) {
        if (!foreground) { Bundle unavailable=new Bundle();unavailable.putBoolean("assistant",false);unavailable.putBoolean("locked",true);return unavailable; }
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        boolean locked = keyguard == null || keyguard.isKeyguardLocked();
        String origin = invocation().take(bridge, generation, bindingId, session, SystemClock.elapsedRealtime(), locked || !foreground);
        Bundle out = new Bundle();
        out.putBoolean("assistant", origin != null); out.putString("invocation", origin); out.putBoolean("locked", locked);
        return out;
    }
}

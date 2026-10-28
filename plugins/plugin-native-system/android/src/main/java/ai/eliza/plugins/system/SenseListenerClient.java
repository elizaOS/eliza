package ai.eliza.plugins.system;

import android.app.KeyguardManager;
import android.app.Activity;
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
import java.util.WeakHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** Nonprivileged access to the same-signer image listener. No enable/resume surface exists. */
public final class SenseListenerClient {
    public static final String SETTINGS_ACTIVITY = "ai.eliza.sense.SETTINGS_ACTIVITY";
    private static final Map<String, SenseInvocation> invocations = new HashMap<>();
    private static final Map<Activity, Long> activityBridges = new WeakHashMap<>();
    private static final Map<Activity, PowerLaunch> powerLaunches = new WeakHashMap<>();
    /** Native host policy only. Neither this validator nor launch minting is exposed to JavaScript. */
    public interface PowerLaunchValidator {
        boolean isCurrent();
        /** Validate the pinned native authority and invoke consume synchronously under host authorization locks. */
        boolean authorize(String accountRef, java.util.function.BooleanSupplier consume);
    }
    private static final class PowerLaunch {
        final long arrivedAt;
        final PowerLaunchValidator validator;
        long bridge;
        int generation;
        String bindingId, session;
        boolean invalid, focused, reserved;
        PowerLaunch(long now, PowerLaunchValidator validator) { this.arrivedAt = now; this.validator = validator; }
        synchronized void attach(long next) {
            if (next <= 0 || bridge != 0 && bridge != next) { invalid = true; reserved = false; }
            if (bridge == 0) bridge = next;
        }
        synchronized void bind(long nextBridge, int nextGeneration, String nextBinding, String nextSession) {
            if (nextBridge != bridge) { invalid = true; reserved = false; return; }
            if (bindingId != null && (generation != nextGeneration || !bindingId.equals(nextBinding))) { invalid = true; reserved = false; }
            if (session != null && !session.equals(nextSession)) { invalid = true; reserved = false; }
            generation = nextGeneration; bindingId = nextBinding; session = nextSession;
        }
        synchronized void focus(boolean value) { if (focused && !value) { invalid = true; reserved = false; } if (value) focused = true; }
        synchronized void cancel() { invalid = true; reserved = false; }
        synchronized PowerLaunchValidator reserveClaim(long nextBridge, int nextGeneration, String nextBinding, String nextSession, long now) {
            boolean accepted = !invalid && focused && bridge == nextBridge && generation == nextGeneration
                    && bindingId != null && bindingId.equals(nextBinding) && session != null && session.equals(nextSession)
                    && now >= arrivedAt && now - arrivedAt <= SenseInvocation.WINDOW_MS;
            invalid = true; // An attempt is final, including failed validation or a throwing host callback.
            reserved = accepted; return accepted ? validator : null;
        }
    }
    private final Activity activity;
    private static final AtomicLong bridgeGenerations = new AtomicLong();
    public static long nextInvocationBridge() { return bridgeGenerations.incrementAndGet(); }
    private final Context context;
    private final String packageName;

    public SenseListenerClient(Context context) {
        this.activity = context instanceof Activity ? (Activity) context : null;
        Context app = context.getApplicationContext();
        this.context = app == null ? context : app;
        this.packageName = context.getPackageName() + ".sense";
    }

    /** The image listener package exists for this user, whatever its signer or control grant. */
    public boolean installed() {
        try { context.getPackageManager().getApplicationInfo(packageName, 0); return true; }
        catch (PackageManager.NameNotFoundException | RuntimeException absent) { return false; }
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
        cancelProtectedPowerLaunch();
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

    public void bindInvocationSession(long bridge, int generation, String bindingId, String session) {
        SenseInvocation state = invocation();
        synchronized (state) {
            state.bind(bridge, generation, bindingId, session, SystemClock.elapsedRealtime());
            if (activity != null && state.boundTo(bridge, generation, bindingId, session)) synchronized (activityBridges) {
                activityBridges.put(activity, bridge);
            }
        }
        PowerLaunch launch = powerLaunch();
        if (launch != null && state.isCurrentRenderer(bridge, generation) && (session == null || state.boundTo(bridge, generation, bindingId, session))) launch.bind(bridge, generation, bindingId, session);
    }

    /**
     * Registers the host's native owner admission for this host package: the non-secret identity of
     * the owner whose authenticated session may claim a wake that arrived before the renderer bound
     * one. Call it from native startup (before the assistant activity records an invocation); null
     * removes it. Without it a cold wake only opens the assistant.
     */
    public void admitOwner(SenseInvocation.OwnerAdmission admission) { invocation().admit(admission); }
    public void releaseInvocationBridge(long bridge) {
        invocation().release(bridge);
        PowerLaunch launch = powerLaunch();
        if (launch != null) launch.cancel();
        synchronized (activityBridges) { activityBridges.entrySet().removeIf(entry -> entry.getValue() == bridge); }
    }

    /** The platform system UI package; its assistant launches carry its identity only on an image that shares it. */
    public static final String SYSTEM_UI_PACKAGE = "com.android.systemui";

    /**
     * Caller package must come from Android's Activity caller API ({@code getLaunchedFromPackage},
     * {@code ComponentCaller}), never an extra or deep link. The same-signer listener marks a
     * listener wake; the platform-signed system UI marks an assistant gesture
     * ({@link SenseInvocation#SYSTEM}). Android reports the system UI as caller only when it shares
     * its identity with the launch (an image patch); otherwise the caller is unknown and the launch
     * only opens the assistant.
     */
    public void recordInvocation(String callerPackage) {
        boolean sameSigner = false;
        try { sameSigner = callerPackage != null && context.getPackageManager().checkSignatures(context.getPackageName(), callerPackage) == PackageManager.SIGNATURE_MATCH; } catch (RuntimeException unavailable) { }
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        invocation().record(context.getPackageName(), callerPackage, sameSigner, systemAssistCaller(callerPackage), SystemClock.elapsedRealtime(), keyguard == null || keyguard.isKeyguardLocked());
    }

    /**
     * Exactly the system UI package, signed with the platform certificate. Platform-signed packages
     * are visible to every app, so an unsigned or absent package fails closed here.
     */
    private boolean systemAssistCaller(String callerPackage) {
        if (!SYSTEM_UI_PACKAGE.equals(callerPackage)) return false;
        try { return context.getPackageManager().checkSignatures("android", callerPackage) == PackageManager.SIGNATURE_MATCH; }
        catch (RuntimeException unavailable) { return false; }
    }

    private boolean protectedPowerActivity() {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return false;
        try {
            ComponentName component = activity.getComponentName();
            ActivityInfo info = context.getPackageManager().getActivityInfo(component, 0);
            if (!context.getPackageName().equals(component.getPackageName()) || !component.getClassName().equals(activity.getClass().getName())
                    || !component.getClassName().equals(info.name) || !context.getPackageName().equals(info.packageName)
                    || info.targetActivity != null || !info.exported || !info.enabled || info.applicationInfo == null
                    || !info.applicationInfo.enabled || !"android.permission.STATUS_BAR_SERVICE".equals(info.permission)) return false;
        } catch (PackageManager.NameNotFoundException | RuntimeException unavailable) { return false; }
        return true;
    }

    private PowerLaunch powerLaunch() {
        synchronized (powerLaunches) { return activity == null ? null : powerLaunches.get(activity); }
    }

    /** Native-only fresh protected launch authorization, distinct from an unbound invocation. */
    public boolean beginProtectedPowerLaunch(PowerLaunchValidator validator) {
        if (!protectedPowerActivity() || validator == null) return false;
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        if (keyguard == null || keyguard.isKeyguardLocked()) return false;
        try { if (!validator.isCurrent()) return false; }
        catch (RuntimeException unavailable) { return false; }
        synchronized (powerLaunches) {
            // An Activity lifetime gets one initial launch grant. Calls cannot refresh its deadline.
            if (powerLaunches.containsKey(activity)) return false;
            powerLaunches.put(activity, new PowerLaunch(SystemClock.elapsedRealtime(), validator));
        }
        return true;
    }
    public void attachProtectedPowerBridge(long bridge) {
        PowerLaunch launch = powerLaunch(); if (launch != null) launch.attach(bridge);
    }
    public void protectedPowerWindowFocusChanged(boolean focused) {
        PowerLaunch launch = powerLaunch(); if (launch != null) launch.focus(focused);
    }
    public void cancelProtectedPowerLaunch() {
        PowerLaunch launch = powerLaunch(); if (launch != null) launch.cancel();
    }
    public void discardProtectedPowerLaunch(long bridge, int generation, String bindingId, String session) {
        PowerLaunch launch = powerLaunch();
        if (launch != null) synchronized (launch) {
            if (launch.bridge == bridge && launch.generation == generation && bindingId != null && bindingId.equals(launch.bindingId)
                    && java.util.Objects.equals(session, launch.session)) launch.cancel();
        }
    }
    public Bundle claimProtectedPowerLaunch(long bridge, int generation, String bindingId, String session, String accountRef, boolean foreground) {
        Bundle out = new Bundle(); out.putBoolean("assistant", false); out.putBoolean("locked", true);
        PowerLaunch launch = powerLaunch();
        if (launch == null) return out;
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        boolean locked = keyguard == null || keyguard.isKeyguardLocked();
        SenseInvocation state = invocation();
        if (!foreground || locked || !protectedPowerActivity() || !state.boundTo(bridge, generation, bindingId, session)) {
            discardProtectedPowerLaunch(bridge, generation, bindingId, session); return out;
        }
        PowerLaunchValidator validator = launch.reserveClaim(bridge, generation, bindingId, session, SystemClock.elapsedRealtime());
        // The grant is spent before calling product policy. Never hold SDK locks across host locks.
        if (validator == null || accountRef == null) return out;
        final boolean[] admitted = {false};
        final java.util.concurrent.atomic.AtomicBoolean attempted = new java.util.concurrent.atomic.AtomicBoolean();
        try {
            boolean authorized = validator.authorize(accountRef, () -> {
                if (!attempted.compareAndSet(false, true)) return false;
                synchronized (state) {
                    KeyguardManager currentKeyguard = context.getSystemService(KeyguardManager.class);
                    long now = SystemClock.elapsedRealtime();
                    synchronized (launch) {
                        admitted[0] = launch.reserved && currentKeyguard != null && !currentKeyguard.isKeyguardLocked() && protectedPowerActivity()
                                && activity.hasWindowFocus() && state.boundTo(bridge, generation, bindingId, session)
                                && now >= launch.arrivedAt && now - launch.arrivedAt <= SenseInvocation.WINDOW_MS;
                        launch.reserved = false;
                        return admitted[0];
                    }
                }
            });
            if (!authorized || !admitted[0]) return out;
        } catch (RuntimeException unavailable) { return out; }
        out.putBoolean("assistant", true); out.putString("invocation", "power"); out.putBoolean("locked", false);
        return out;
    }

    /** Native-only hook for a warm permission-protected Power Activity; never exposed as a JS method. */
    public boolean recordProtectedPower() {
        if (!protectedPowerActivity()) return false;
        final Long bridge;
        synchronized (activityBridges) { bridge = activityBridges.get(activity); }
        if (bridge == null) return false;
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        return invocation().recordProtectedPower(bridge, SystemClock.elapsedRealtime(), keyguard == null || keyguard.isKeyguardLocked());
    }

    public void discardProtectedPowerInvocation(long bridge, int generation, String bindingId, String session) {
        invocation().discardProtectedPower(bridge, generation, bindingId, session);
    }

    public Bundle takeInvocation(long bridge, int generation, String bindingId, String session, boolean foreground) {
        if (!foreground) { invocation().discardProtectedPower(bridge, generation, bindingId, session); Bundle unavailable=new Bundle();unavailable.putBoolean("assistant",false);unavailable.putBoolean("locked",true);return unavailable; }
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        boolean locked = keyguard == null || keyguard.isKeyguardLocked();
        String origin = invocation().take(bridge, generation, bindingId, session, SystemClock.elapsedRealtime(), locked || !foreground);
        Bundle out = new Bundle();
        out.putBoolean("assistant", origin != null); out.putString("invocation", origin); out.putBoolean("locked", locked);
        return out;
    }
}

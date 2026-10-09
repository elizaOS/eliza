/**
 * Re-enters the opted-in LP3 color guard whenever Android creates the app
 * process. The direct-debug-only provider closes the force-stop recovery gap:
 * a normal user launch reaches this initializer before MainActivity, while an
 * activity-resume retry runs from a foreground context. A process-scoped
 * protected-broadcast listener also restores the service after app/channel
 * notification disclosure is unblocked without repeating the permission prompt.
 */
package ai.elizaos.app;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

public final class Lp3ColorPolicyInitializer extends ContentProvider
        implements Application.ActivityLifecycleCallbacks {
    private static final String TAG = "ElizaLp3Color";
    private static final int REQUEST_CODE_POST_NOTIFICATIONS = 16903;

    private Application processApplication;
    private Application callbackApplication;
    private final Lp3ColorPolicy.LifecycleRegistration notificationStateRegistration =
        new Lp3ColorPolicy.LifecycleRegistration();
    private BroadcastReceiver notificationStateReceiver;
    private boolean notificationPermissionRequested;

    @Override
    public boolean onCreate() {
        Context providerContext = getContext();
        if (providerContext == null) {
            throw new IllegalStateException("LP3 color initializer has no Android context");
        }
        Context appContext = providerContext.getApplicationContext();
        if (!(appContext instanceof Application)) {
            throw new IllegalStateException("LP3 color initializer has no Application context");
        }

        Application app = (Application) appContext;
        processApplication = app;
        try {
            Lp3ColorPolicy.Decision decision =
                Lp3ColorPolicyService.currentDecision(appContext);
            updateNotificationStateReceiver(decision);
            updateActivityCallbacks(decision);
            Lp3ColorPolicyService.sync(appContext, "process-start");
        } catch (RuntimeException error) {
            // error-policy:J1 Android process-start boundary — eligibility and
            // notification-state monitoring must both be established before a
            // privileged display guard may run.
            Log.e(TAG, "[Lp3ColorPolicy] process-start eligibility read failed", error);
            appContext.stopService(new Intent(appContext, Lp3ColorPolicyService.class));
        }
        return true;
    }

    @Override
    public void onActivityResumed(Activity activity) {
        Lp3ColorPolicy.Decision decision;
        try {
            decision = Lp3ColorPolicyService.currentDecision(activity);
            updateNotificationStateReceiver(decision);
        } catch (RuntimeException error) {
            // error-policy:J1 Android activity boundary — an unreadable gate
            // cannot authorize either a permission prompt or a service start.
            Log.e(TAG, "[Lp3ColorPolicy] foreground eligibility read failed", error);
            unregisterActivityCallbacks();
            activity.stopService(new Intent(activity, Lp3ColorPolicyService.class));
            return;
        }

        if (decision == Lp3ColorPolicy.Decision.ELIGIBLE) {
            unregisterActivityCallbacks();
            Lp3ColorPolicyService.sync(activity, "activity-resumed");
            return;
        }
        if (
            Lp3ColorPolicy.shouldRequestPostNotifications(
                decision,
                notificationPermissionRequested
            )
        ) {
            notificationPermissionRequested = true;
            activity.requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQUEST_CODE_POST_NOTIFICATIONS
            );
            return;
        }
        if (Lp3ColorPolicy.canRecoverThroughNotificationState(decision)) {
            Lp3ColorPolicyService.sync(activity, "activity-resumed-notification-ineligible");
            return;
        }
        unregisterActivityCallbacks();
        Lp3ColorPolicyService.sync(activity, "activity-resumed-ineligible");
    }

    private void updateActivityCallbacks(Lp3ColorPolicy.Decision decision) {
        if (Lp3ColorPolicy.canRecoverThroughNotificationState(decision)) {
            registerActivityCallbacks();
        } else {
            unregisterActivityCallbacks();
        }
    }

    private void registerActivityCallbacks() {
        if (callbackApplication != null) return;
        Application app = processApplication;
        if (app == null) {
            throw new IllegalStateException("LP3 color initializer lost Application context");
        }
        app.registerActivityLifecycleCallbacks(this);
        callbackApplication = app;
    }

    private void unregisterActivityCallbacks() {
        Application registeredApplication = callbackApplication;
        if (registeredApplication == null) return;
        registeredApplication.unregisterActivityLifecycleCallbacks(this);
        callbackApplication = null;
    }

    private void updateNotificationStateReceiver(Lp3ColorPolicy.Decision decision) {
        boolean shouldRegister = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            && Lp3ColorPolicy.canRecoverThroughNotificationState(decision);
        notificationStateRegistration.update(
            shouldRegister,
            new Lp3ColorPolicy.RegistrationHooks() {
                @Override
                public void register() {
                    Application app = processApplication;
                    if (app == null) {
                        throw new IllegalStateException(
                            "LP3 color initializer lost Application context"
                        );
                    }
                    BroadcastReceiver candidate = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            String action = intent == null ? null : intent.getAction();
                            String channelId = intent == null
                                ? null
                                : intent.getStringExtra(
                                    NotificationManager.EXTRA_NOTIFICATION_CHANNEL_ID
                                );
                            if (
                                !Lp3ColorPolicy.acceptsNotificationStateChange(
                                    action,
                                    channelId
                                )
                            ) {
                                return;
                            }
                            reconcileNotificationState(context, action);
                        }
                    };
                    Lp3ColorPolicyService.registerNotificationStateReceiver(
                        app,
                        candidate
                    );
                    notificationStateReceiver = candidate;
                }

                @Override
                public void unregister() {
                    Application app = processApplication;
                    BroadcastReceiver registeredReceiver = notificationStateReceiver;
                    if (app == null || registeredReceiver == null) {
                        throw new IllegalStateException(
                            "LP3 notification recovery receiver registration lost"
                        );
                    }
                    app.unregisterReceiver(registeredReceiver);
                    notificationStateReceiver = null;
                }
            }
        );
    }

    private void reconcileNotificationState(Context context, String action) {
        try {
            Lp3ColorPolicy.Decision decision =
                Lp3ColorPolicyService.currentDecision(context);
            updateNotificationStateReceiver(decision);
            updateActivityCallbacks(decision);
            Lp3ColorPolicyService.sync(context, "notification-state-change:" + action);
        } catch (RuntimeException error) {
            // error-policy:J1 protected system-broadcast boundary — a malformed
            // or unreadable notification transition cannot authorize an
            // invisible privileged guard.
            Log.e(TAG, "[Lp3ColorPolicy] notification-state reconciliation failed", error);
            context.stopService(new Intent(context, Lp3ColorPolicyService.class));
        }
    }

    @Override
    public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}

    @Override
    public void onActivityStarted(Activity activity) {}

    @Override
    public void onActivityPaused(Activity activity) {}

    @Override
    public void onActivityStopped(Activity activity) {}

    @Override
    public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}

    @Override
    public void onActivityDestroyed(Activity activity) {}

    @Override
    public Cursor query(
            Uri uri,
            String[] projection,
            String selection,
            String[] selectionArgs,
            String sortOrder) {
        throw unsupportedDataOperation();
    }

    @Override
    public String getType(Uri uri) {
        throw unsupportedDataOperation();
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw unsupportedDataOperation();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw unsupportedDataOperation();
    }

    @Override
    public int update(
            Uri uri,
            ContentValues values,
            String selection,
            String[] selectionArgs) {
        throw unsupportedDataOperation();
    }

    private static UnsupportedOperationException unsupportedDataOperation() {
        return new UnsupportedOperationException(
            "LP3 color initializer does not expose provider data"
        );
    }
}

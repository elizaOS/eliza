/**
 * Re-enters the opted-in LP3 color guard whenever Android creates the app
 * process. The direct-debug-only provider closes the force-stop recovery gap:
 * a normal user launch reaches this initializer before MainActivity, while an
 * activity-resume retry runs from a foreground context and can request the
 * notification permission required for an honest foreground service.
 */
package ai.elizaos.app;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

public final class Lp3ColorPolicyInitializer extends ContentProvider
        implements Application.ActivityLifecycleCallbacks {
    private static final String TAG = "ElizaLp3Color";
    private static final int REQUEST_CODE_POST_NOTIFICATIONS = 16903;

    private Application application;
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
        try {
            Lp3ColorPolicy.Decision decision =
                Lp3ColorPolicyService.currentDecision(appContext);
            if (
                decision == Lp3ColorPolicy.Decision.ELIGIBLE
                    || decision
                        == Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION
            ) {
                application = app;
                application.registerActivityLifecycleCallbacks(this);
            }
        } catch (RuntimeException error) {
            // error-policy:J1 Android process-start boundary — the service
            // performs its own authoritative gate and logs the same failure;
            // do not retain activity callbacks after an unreadable state.
            Log.e(TAG, "[Lp3ColorPolicy] process-start eligibility read failed", error);
        }
        Lp3ColorPolicyService.sync(appContext, "process-start");
        return true;
    }

    @Override
    public void onActivityResumed(Activity activity) {
        Lp3ColorPolicy.Decision decision;
        try {
            decision = Lp3ColorPolicyService.currentDecision(activity);
        } catch (RuntimeException error) {
            // error-policy:J1 Android activity boundary — an unreadable gate
            // cannot authorize either a permission prompt or a service start.
            Log.e(TAG, "[Lp3ColorPolicy] foreground eligibility read failed", error);
            unregisterActivityCallbacks();
            return;
        }

        if (decision == Lp3ColorPolicy.Decision.ELIGIBLE) {
            unregisterActivityCallbacks();
            Lp3ColorPolicyService.sync(activity, "activity-resumed");
            return;
        }
        if (
            decision == Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION
                && !notificationPermissionRequested
        ) {
            notificationPermissionRequested = true;
            activity.requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQUEST_CODE_POST_NOTIFICATIONS
            );
            return;
        }
        if (decision != Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION) {
            unregisterActivityCallbacks();
            Lp3ColorPolicyService.sync(activity, "activity-resumed-ineligible");
        }
    }

    private void unregisterActivityCallbacks() {
        Application registeredApplication = application;
        if (registeredApplication == null) return;
        registeredApplication.unregisterActivityLifecycleCallbacks(this);
        application = null;
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

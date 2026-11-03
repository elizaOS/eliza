package ai.tokenjunction.valhalla;

import android.app.Activity;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.UpdateAvailability;

/** Play builds use Play's own updater. Sideload builds do not call this. */
final class PlayUpdate {
    static void check(Activity activity) {
        if (!BuildConfig.STORE_BILLING) return;
        var manager = AppUpdateManagerFactory.create(activity);
        manager.getAppUpdateInfo().addOnSuccessListener(info -> {
            if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                    && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)) {
                try {
                    manager.startUpdateFlowForResult(
                            info,
                            activity,
                            AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
                            9101);
                } catch (Exception ignored) {
                    // Play may refuse the update sheet. The app keeps running.
                }
            }
        });
    }
}

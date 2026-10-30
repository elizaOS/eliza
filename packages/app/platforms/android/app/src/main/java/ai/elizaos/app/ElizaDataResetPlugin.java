package ai.elizaos.app;

import ai.eliza.plugins.system.reset.DataReset;
import ai.eliza.plugins.system.reset.DataResetCopy;
import ai.eliza.plugins.system.reset.DataResetPlugin;
import android.content.Context;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Reset app data" for this app, hosted on the shared reset coordinator
 * ({@code plugin-native-system} {@code reset.DataResetPlugin}): native disclosure, a fresh Android
 * device-credential confirmation, a durable request, then Android's package-scoped clear. The
 * renderer only calls {@code review()} with no arguments; nothing it sends authorizes a reset.
 *
 * <p>This class also defines the app's installed reset identities. {@link ElizaApplication} owns
 * the single {@link DataReset} built here and shares it with this plugin and
 * {@link ElizaDataResetRecoveryActivity}.
 */
@CapacitorPlugin(name = ElizaDataResetPlugin.PLUGIN_NAME)
public final class ElizaDataResetPlugin extends DataResetPlugin {
    /** Renderer-visible plugin name (packages/ui {@code ANDROID_DATA_RESET_PLUGIN}). */
    static final String PLUGIN_NAME = "ElizaDataReset";
    /**
     * Installed base name of the pending marker and attempt counter. Never rename it: an
     * interrupted reset from an earlier build must still resume.
     */
    static final String MARKER_NAME = "eliza-data-reset";
    /** {@code android:process} of {@link ElizaDataResetRecoveryActivity} in the manifest. */
    static final String RECOVERY_PROCESS_SUFFIX = ":reset_recovery";
    static final String LOG_TAG = "ElizaDataReset";
    /**
     * Port for revoking this device's Eliza Cloud key before the clear (packages/auth
     * {@code ai.eliza.auth.cloud.CloudKeyRevocation.resetStep}). This app does not host the native
     * Cloud sign-in yet ({@code CloudSignInPlugin} with its registration and credential slots), so
     * there is no native registration to revoke against and the port stays empty: a reset removes
     * the stored credential from this phone only, and the disclosure says so. Wire it here, and
     * update {@link #disclosure}, when the native sign-in lands.
     */
    static final DataReset.BeforeDispatch CLOUD_KEY_REVOCATION = null;

    /** Builds the app's coordinator; {@link ElizaApplication#DATA_RESET} holds the one instance. */
    static DataReset coordinator() {
        return DataReset.builder(MARKER_NAME, ElizaDataResetRecoveryActivity.class)
                .recoveryProcessSuffix(RECOVERY_PROCESS_SUFFIX)
                .logTag(LOG_TAG)
                .beforeDispatch(CLOUD_KEY_REVOCATION)
                .build();
    }

    /** The name people see for this build (white-label forks relabel the app). */
    static String productName(Context context) {
        try {
            CharSequence label = context.getApplicationInfo().loadLabel(context.getPackageManager());
            String name = label == null ? "" : label.toString().trim();
            if (!name.isEmpty() && name.length() <= 60) return name;
        } catch (RuntimeException unavailable) {
            // Fall through to the neutral name.
        }
        return "this app";
    }

    /**
     * What a reset deletes, naming every store in {@link ElizaDataResetStores}, and what it does
     * not: remote sign-ins are not revoked, remote data and subscriptions are untouched.
     */
    static String disclosure(String product) {
        StringBuilder held = new StringBuilder();
        for (String holding : ElizaDataResetStores.holdings()) held.append(holding).append(", ");
        return "Permanently delete " + product + "'s local data on this phone: its " + held
                + "settings and files in its private storage. Stop its agent and pending work. There is no backup or undo.\n\n"
                + "Cloud sign-ins are removed from this phone but are not revoked on the server. "
                + "Device-wide photos and files, remote account data and subscriptions are not deleted or cancelled. "
                + "Other apps are not reset. " + product + " will close; open it again to start fresh.\n\n"
                + "Confirm, then unlock your device to continue.";
    }

    static DataResetCopy copyFor(String product) {
        return DataResetCopy.forProduct(product).disclosure(disclosure(product)).build();
    }

    @Override
    protected DataReset reset() {
        return ElizaApplication.DATA_RESET;
    }

    @Override
    protected DataResetCopy copy() {
        return copyFor(productName(getContext()));
    }
}

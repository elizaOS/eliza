package ai.elizaos.app;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The app's persistent stores that "Reset app data" must cover, with their installed locations.
 *
 * <p>The shared coordinator ({@code ai.eliza.plugins.system.reset.DataReset}) deletes nothing by
 * name: Android's {@code clearApplicationUserData()} clears this package's whole private storage
 * (credential- and device-protected), its UID Keystore namespace, jobs, alarms and notifications.
 * This list exists so that claim stays checkable: every store lives in a package-private area that
 * clear covers, the native disclosure names what each one holds, and a store moved outside those
 * areas (for example to shared storage) fails {@code ElizaDataResetStoresTest} instead of silently
 * surviving a reset. Names are installed identities read from the owning classes, never renamed
 * here.
 */
final class ElizaDataResetStores {
    /** Package-private storage areas that Android's per-package clear deletes. */
    enum Area {
        /** {@code Context.getFilesDir()} in credential-protected storage. */
        FILES,
        /** {@code Context.getNoBackupFilesDir()} in credential-protected storage. */
        NO_BACKUP_FILES,
        /** {@code SharedPreferences} in device-protected storage ({@code shared_prefs/<name>.xml}). */
        DEVICE_PROTECTED_PREFERENCES,
        /** An alias in this app's UID Android Keystore namespace. */
        ANDROID_KEYSTORE
    }

    static final class Store {
        /** The class that owns the store. */
        final String owner;
        final Area area;
        /** Relative path inside {@link #area}, a preferences name, or a Keystore alias. */
        final String name;
        /** What the store holds, as the native disclosure names it. */
        final String holds;

        Store(String owner, Area area, String name, String holds) {
            this.owner = owner;
            this.area = area;
            this.name = name;
            this.holds = holds;
        }

        @Override
        public String toString() {
            return owner + ":" + area + ":" + name;
        }
    }

    /**
     * Installed Keystore alias of the shared native secure store (plugin-native-secure-store
     * {@code NativeSecureStore.KEY_ALIAS}, private there; the test checks the two agree).
     */
    static final String NATIVE_SECURE_STORE_KEY_ALIAS = "ai.elizaos.secure-store.v1";
    /** Installed no-backup directory of the shared native secure store. */
    static final String NATIVE_SECURE_STORE_DIRECTORY = "eliza-secure-store";

    static final List<Store> ALL = Collections.unmodifiableList(Arrays.asList(
            new Store("AgentSecureStore", Area.NO_BACKUP_FILES, AgentSecureStore.DIRECTORY_NAME,
                    "remote agent connection secrets"),
            new Store("AgentSecureStore", Area.ANDROID_KEYSTORE, AgentSecureStore.KEY_ALIAS,
                    "remote agent connection secrets"),
            new Store("NativeSecureStore", Area.NO_BACKUP_FILES, NATIVE_SECURE_STORE_DIRECTORY,
                    "saved sign-ins"),
            new Store("NativeSecureStore", Area.ANDROID_KEYSTORE, NATIVE_SECURE_STORE_KEY_ALIAS,
                    "saved sign-ins"),
            new Store("ElizaAlarms", Area.DEVICE_PROTECTED_PREFERENCES, ElizaAlarms.PREFS,
                    "alarms"),
            new Store("NativeNotificationInbox", Area.NO_BACKUP_FILES, NativeNotificationInbox.DIRECTORY_NAME,
                    "saved notifications"),
            new Store("ElizaAgentService", Area.FILES, ElizaAgentService.AGENT_STATE_DIR_NAME,
                    "conversations and agent memory"),
            new Store("ElizaAgentService", Area.FILES,
                    ElizaAgentService.AGENT_STATE_DIR_NAME + "/" + ElizaAgentService.WORKFLOW_STATE_DIR_NAME,
                    "workflows")));

    private ElizaDataResetStores() {}

    /** Distinct {@link Store#holds} phrases in list order, for the disclosure. */
    static List<String> holdings() {
        List<String> result = new ArrayList<>();
        for (Store store : ALL) if (!result.contains(store.holds)) result.add(store.holds);
        return Collections.unmodifiableList(result);
    }

    /**
     * Where a file-backed store lives, given this app's storage roots; null for a Keystore alias.
     * Throws if the name could leave its area (absolute, parent segments, empty segments).
     */
    static File location(Store store, File filesDir, File noBackupFilesDir, File deviceProtectedDataDir) {
        if (store.area == Area.ANDROID_KEYSTORE) return null;
        for (String segment : store.name.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException("Store path leaves its area: " + store);
            }
        }
        switch (store.area) {
            case FILES: return new File(filesDir, store.name);
            case NO_BACKUP_FILES: return new File(noBackupFilesDir, store.name);
            case DEVICE_PROTECTED_PREFERENCES:
                return new File(new File(deviceProtectedDataDir, "shared_prefs"), store.name + ".xml");
            default: throw new IllegalArgumentException("Unknown area: " + store);
        }
    }
}

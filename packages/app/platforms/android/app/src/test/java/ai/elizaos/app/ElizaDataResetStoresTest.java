/**
 * JVM tests for this app's "Reset app data" host: the store list Android's package-scoped clear
 * must cover, the installed reset identities, the manifest declaration and the native disclosure.
 * The coordinator itself is tested in plugins/plugin-native-system (DataResetTest).
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.eliza.plugins.system.reset.DataResetCopy;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ElizaDataResetStoresTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void storeListNamesEveryAppStoreAtItsInstalledLocation() {
        List<String> stores = new ArrayList<>();
        for (ElizaDataResetStores.Store store : ElizaDataResetStores.ALL) stores.add(store.toString());
        assertEquals(Arrays.asList(
                "AgentSecureStore:NO_BACKUP_FILES:remote-target-secrets",
                "AgentSecureStore:ANDROID_KEYSTORE:ai.elizaos.app.remote-target.v1",
                "NativeSecureStore:NO_BACKUP_FILES:eliza-secure-store",
                "NativeSecureStore:ANDROID_KEYSTORE:ai.elizaos.secure-store.v1",
                "ElizaAlarms:DEVICE_PROTECTED_PREFERENCES:eliza_owned_native_alarms",
                "NativeNotificationInbox:NO_BACKUP_FILES:native-notification-inbox",
                "ElizaAgentService:FILES:.eliza",
                "ElizaAgentService:FILES:.eliza/smthrs"), stores);
        assertEquals("no store is listed twice", stores.size(), new HashSet<>(stores).size());
    }

    @Test
    public void everyFileStoreResolvesInsidePackagePrivateStorage() throws Exception {
        File files = temp.newFolder("data", "files");
        File noBackup = temp.newFolder("data", "no_backup");
        File deviceProtected = temp.newFolder("user_de", "data");
        for (ElizaDataResetStores.Store store : ElizaDataResetStores.ALL) {
            assertFalse(store + " holds", store.holds.trim().isEmpty());
            File location = ElizaDataResetStores.location(store, files, noBackup, deviceProtected);
            if (store.area == ElizaDataResetStores.Area.ANDROID_KEYSTORE) {
                assertNull(store + " has no path", location);
                assertTrue(store + " is an alias of this app", store.name.startsWith("ai.elizaos."));
                continue;
            }
            File root = store.area == ElizaDataResetStores.Area.FILES ? files
                    : store.area == ElizaDataResetStores.Area.NO_BACKUP_FILES ? noBackup : deviceProtected;
            String path = location.getCanonicalPath();
            assertTrue(store + " stays in " + store.area, path.startsWith(root.getCanonicalPath() + File.separator));
        }
        File alarms = ElizaDataResetStores.location(ElizaDataResetStores.ALL.get(4), files, noBackup, deviceProtected);
        assertEquals(new File(new File(deviceProtected, "shared_prefs"), "eliza_owned_native_alarms.xml"), alarms);
    }

    @Test
    public void aStoreThatCouldLeaveItsAreaIsRejected() {
        File root = temp.getRoot();
        for (String name : new String[] {"", "/data/media/0/eliza", "../shared", "a//b", "a/./b", ".eliza/.."}) {
            ElizaDataResetStores.Store store = new ElizaDataResetStores.Store("Fixture", ElizaDataResetStores.Area.FILES, name, "fixture");
            try {
                ElizaDataResetStores.location(store, root, root, root);
                fail("accepted " + name);
            } catch (IllegalArgumentException expected) {
                // Rejected.
            }
        }
    }

    @Test
    public void sharedSecureStoreIdentitiesMatchThePlugin() throws Exception {
        Class<?> owner = Class.forName("ai.eliza.plugins.securestore.nativeonly.NativeSecureStore");
        Field alias = owner.getDeclaredField("KEY_ALIAS");
        alias.setAccessible(true);
        assertEquals(alias.get(null), ElizaDataResetStores.NATIVE_SECURE_STORE_KEY_ALIAS);
        File source = repoFile("plugins/plugin-native-secure-store/android/src/main/java/ai/eliza/plugins/securestore/nativeonly/NativeSecureStore.java");
        if (source != null) {
            assertTrue("directory name", read(source).contains("getNoBackupFilesDir(), \"" + ElizaDataResetStores.NATIVE_SECURE_STORE_DIRECTORY + "\")"));
        }
    }

    @Test
    public void coordinatorKeepsItsInstalledIdentities() {
        assertEquals("eliza-data-reset", ElizaDataResetPlugin.MARKER_NAME);
        assertEquals(":reset_recovery", ElizaDataResetPlugin.RECOVERY_PROCESS_SUFFIX);
        assertNotNull(ElizaApplication.DATA_RESET);
        assertEquals(ElizaDataResetPlugin.RECOVERY_PROCESS_SUFFIX, ElizaApplication.DATA_RESET.recoveryProcessSuffix());
        // No native Cloud sign-in is hosted yet, so there is no key revocation to run before the clear.
        assertNull(ElizaDataResetPlugin.CLOUD_KEY_REVOCATION);
        CapacitorPlugin plugin = ElizaDataResetPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertNotNull(plugin);
        assertEquals("ElizaDataReset", plugin.name());
    }

    @Test
    public void disclosureNamesEveryStoreAndWhatIsNotDeleted() {
        DataResetCopy copy = ElizaDataResetPlugin.copyFor("Eliza");
        Set<String> holdings = new HashSet<>(ElizaDataResetStores.holdings());
        assertEquals(6, holdings.size());
        for (String holding : holdings) assertTrue(holding, copy.disclosure.contains(holding));
        assertTrue(copy.disclosure.startsWith("Permanently delete Eliza's local data on this phone: its "));
        assertTrue(copy.disclosure.contains("There is no backup or undo."));
        assertTrue(copy.disclosure.contains("not revoked on the server"));
        assertTrue(copy.disclosure.contains("are not deleted or cancelled") && copy.disclosure.contains("Other apps are not reset."));
        assertTrue(copy.disclosure.endsWith("Confirm, then unlock your device to continue."));
        assertEquals("Reset Eliza data?", copy.reviewTitle);
        // A white-label label flows through unchanged.
        assertTrue(ElizaDataResetPlugin.copyFor("Acme").disclosure.contains("Acme will close"));
    }

    @Test
    public void manifestDeclaresRecoveryUnexportedInItsOwnProcess() throws Exception {
        File manifest = moduleFile("src/main/AndroidManifest.xml");
        String xml = read(manifest).replaceAll("(?s)<!--.*?-->", "");
        Matcher block = Pattern.compile("<activity\\b[^>]*android:name=\"\\.ElizaDataResetRecoveryActivity\"[^>]*/>").matcher(xml);
        assertTrue("recovery activity declared as a self-closing element without intent filters", block.find());
        String activity = block.group();
        assertTrue(activity.contains("android:exported=\"false\""));
        assertTrue(activity.contains("android:process=\"" + ElizaDataResetPlugin.RECOVERY_PROCESS_SUFFIX + "\""));
        assertTrue(activity.contains("android:excludeFromRecents=\"true\""));
        assertTrue(activity.contains("android:launchMode=\"singleTask\""));
        assertTrue(activity.contains("android:taskAffinity=\"${applicationId}.reset\""));
        assertFalse("only one declaration", block.find());
        assertFalse("no provider runs in the recovery process", xml.matches("(?s).*<provider\\b[^>]*android:process=\"" + Pattern.quote(ElizaDataResetPlugin.RECOVERY_PROCESS_SUFFIX) + "\".*"));
        assertTrue(xml.contains("android:name=\".ElizaApplication\""));
        String main = read(moduleFile("src/main/java/ai/elizaos/app/MainActivity.java"));
        assertTrue("plugin registered", main.contains("registerPlugin(ElizaDataResetPlugin.class);"));
    }

    private static File moduleFile(String relative) {
        File direct = new File(relative);
        if (direct.isFile()) return direct;
        File nested = new File("app", relative);
        if (nested.isFile()) return nested;
        throw new AssertionError("Cannot find " + relative + " from " + new File("").getAbsolutePath());
    }

    /** The eliza checkout file, or null when this Android project is built outside it. */
    private static File repoFile(String relative) {
        for (File dir = new File("").getAbsoluteFile(); dir != null; dir = dir.getParentFile()) {
            File candidate = new File(dir, relative);
            if (candidate.isFile()) return candidate;
        }
        return null;
    }

    private static String read(File file) throws Exception {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
}

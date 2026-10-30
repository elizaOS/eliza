package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Image contract for Eliza installed by an elizaOS AOSP image under the
 * nonprivileged-launcher profile (packages/os/android/products/eliza-images.json,
 * mirrored by packages/os/scripts/android/boot-validate.ts):
 *
 * <ul>
 *   <li>installed at /product/app/Eliza/ (or /system/app/Eliza/ on a GSI),
 *       SYSTEM but not PRIVILEGED, and not replaced by an update;</li>
 *   <li>HOME and ASSISTANT are held by Eliza. DIALER and SMS are not
 *       preassigned, so they are not asserted;</li>
 *   <li>stock HOME, dialer and messaging apps stay installed as recovery
 *       paths;</li>
 *   <li>only RECORD_AUDIO and POST_NOTIFICATIONS are default-granted, and no
 *       privileged permission the APK declares is granted.</li>
 * </ul>
 *
 * Every case is skipped for a non-system install (a sideloaded or emulator
 * debug APK); the Cuttlefish image lane fails on any skip.
 */
@RunWith(AndroidJUnit4.class)
public class ElizaOsInstrumentedTest {

    private static final String PACKAGE_NAME = "ai.elizaos.app";
    private static final String[] IMAGE_INSTALL_DIRECTORIES = {
            "/product/app/Eliza/",
            "/system/app/Eliza/",
    };
    /** packages/os/android/products/eliza-images.json defaultPermissions. */
    static final Set<String> DEFAULT_GRANTED_PERMISSIONS = new TreeSet<>(Arrays.asList(
            "android.permission.RECORD_AUDIO",
            "android.permission.POST_NOTIFICATIONS"
    ));
    /** Declared by the APK, never granted to a nonprivileged image launcher. */
    private static final String[] UNGRANTED_PRIVILEGED_PERMISSIONS = {
            "android.permission.MANAGE_APP_OPS_MODES",
            "android.permission.INJECT_EVENTS",
            "android.permission.READ_FRAME_BUFFER",
            "android.permission.REAL_GET_TASKS",
            "android.permission.MANAGE_VIRTUAL_MACHINE",
    };
    private static final Pattern COMPONENT = Pattern.compile("^([A-Za-z][\\w.]*)/[.A-Za-z][\\w.$]*$");
    private static final Pattern RUNTIME_PERMISSION = Pattern.compile(
            "^\\s*([A-Za-z][\\w.]*\\.[A-Za-z0-9_]+): granted=(true|false), flags=\\[([^\\]]*)\\]");

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private ApplicationInfo appInfo() throws PackageManager.NameNotFoundException {
        Context context = context();
        return context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
    }

    /** Shell output through UiAutomation, which sees every package. */
    private static String shell(String command) throws IOException {
        ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation()
                .getUiAutomation()
                .executeShellCommand(command);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static Set<String> systemPackages() throws IOException {
        Set<String> packages = new LinkedHashSet<>();
        for (String line : shell("pm list packages -s").split("\\r?\\n")) {
            if (line.startsWith("package:")) {
                packages.add(line.substring("package:".length()).trim());
            }
        }
        return packages;
    }

    /** Owners of the activities that resolve an intent, from cmd package. */
    private static Set<String> activityOwners(String intentArguments) throws IOException {
        Set<String> owners = new LinkedHashSet<>();
        String output = shell("cmd package query-activities --brief --components " + intentArguments);
        for (String line : output.split("\\r?\\n")) {
            Matcher matcher = COMPONENT.matcher(line.trim());
            if (matcher.matches()) {
                owners.add(matcher.group(1));
            }
        }
        return owners;
    }

    private static void assertSystemRecoveryApp(String role, String intentArguments) throws IOException {
        Set<String> owners = activityOwners(intentArguments);
        owners.remove(PACKAGE_NAME);
        owners.retainAll(systemPackages());
        assertFalse("No stock system " + role + " app remains as a recovery path", owners.isEmpty());
    }

    private void assumeImageEliza() throws PackageManager.NameNotFoundException {
        assumeTrue("ElizaOS image tests only run for the image-installed Eliza APK",
                (appInfo().flags & ApplicationInfo.FLAG_SYSTEM) != 0);
    }

    @Test
    public void packageIsNonprivilegedImageEliza() throws Exception {
        assumeImageEliza();
        ApplicationInfo info = appInfo();

        assertEquals(PACKAGE_NAME, context().getPackageName());
        assertEquals("Eliza must run from the image APK, not an update",
                0, info.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP);
        assertNotNull(info.sourceDir);
        boolean imagePath = false;
        for (String directory : IMAGE_INSTALL_DIRECTORIES) {
            imagePath |= info.sourceDir.startsWith(directory);
        }
        assertTrue("Unexpected install path " + info.sourceDir, imagePath);
        assertFalse("Eliza must not be a priv-app", info.sourceDir.contains("/priv-app/"));

        String dump = shell("dumpsys package " + PACKAGE_NAME);
        assertTrue("Eliza must be a SYSTEM package",
                Pattern.compile("pkgFlags=\\[[^\\]]*\\bSYSTEM\\b").matcher(dump).find());
        assertFalse("Eliza must not be a PRIVILEGED package",
                Pattern.compile("privateFlags=\\[[^\\]]*\\bPRIVILEGED\\b").matcher(dump).find());
    }

    @Test
    public void homeIntentResolvesToEliza() throws Exception {
        assumeImageEliza();
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        ResolveInfo resolved = context().getPackageManager()
                .resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);

        assertNotNull(resolved);
        assertEquals(PACKAGE_NAME, resolved.activityInfo.packageName);
    }

    @Test
    public void elizaHoldsHomeAndAssistantRoles() throws Exception {
        assumeImageEliza();
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        RoleManager roleManager = (RoleManager) context().getSystemService(Context.ROLE_SERVICE);
        assertNotNull(roleManager);

        for (String role : new String[] {RoleManager.ROLE_HOME, RoleManager.ROLE_ASSISTANT}) {
            assertTrue(role + " must be available", roleManager.isRoleAvailable(role));
            assertTrue(role + " must be held by Eliza", roleManager.isRoleHeld(role));
        }
        // DIALER and SMS are not preassigned by the nonprivileged-launcher
        // profile; the person chooses those holders.
    }

    @Test
    public void stockRecoveryAppsRemainInstalled() throws Exception {
        assumeImageEliza();
        assertSystemRecoveryApp("HOME",
                "-a android.intent.action.MAIN -c android.intent.category.HOME");
        PackageManager packageManager = context().getPackageManager();
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
            assertSystemRecoveryApp("dialer", "-a android.intent.action.DIAL -d tel:");
            assertSystemRecoveryApp("messaging", "-a android.intent.action.SENDTO -d smsto:");
        }
    }

    @Test
    public void onlyReviewedPermissionsAreDefaultGranted() throws Exception {
        assumeImageEliza();
        Set<String> defaultGranted = new TreeSet<>();
        Set<String> granted = new TreeSet<>();
        for (String line : shell("dumpsys package " + PACKAGE_NAME).split("\\r?\\n")) {
            Matcher matcher = RUNTIME_PERMISSION.matcher(line);
            if (!matcher.find()) {
                continue;
            }
            if (matcher.group(3).contains("GRANTED_BY_DEFAULT")) {
                defaultGranted.add(matcher.group(1));
                if ("true".equals(matcher.group(2))) {
                    granted.add(matcher.group(1));
                }
            }
        }
        // Later test steps may grant more runtime permissions with pm grant;
        // those are not GRANTED_BY_DEFAULT and do not change this set.
        assertEquals(DEFAULT_GRANTED_PERMISSIONS, defaultGranted);
        assertEquals(DEFAULT_GRANTED_PERMISSIONS, granted);
        for (String permission : DEFAULT_GRANTED_PERMISSIONS) {
            assertEquals(permission, PackageManager.PERMISSION_GRANTED,
                    context().checkSelfPermission(permission));
        }
    }

    @Test
    public void privilegedPermissionsAreNotGranted() throws Exception {
        assumeImageEliza();
        for (String permission : UNGRANTED_PRIVILEGED_PERMISSIONS) {
            assertEquals(permission, PackageManager.PERMISSION_DENIED,
                    context().checkSelfPermission(permission));
        }
    }
}

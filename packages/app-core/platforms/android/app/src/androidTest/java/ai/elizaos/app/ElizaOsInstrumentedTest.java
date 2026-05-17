package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.Manifest;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;
import android.provider.Telephony;
import android.telecom.TelecomManager;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

@RunWith(AndroidJUnit4.class)
public class ElizaOsInstrumentedTest {

    private static final String PACKAGE_NAME = "com.elizaai.eliza";
    private static final String[] REQUIRED_PERMISSIONS = {
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.WRITE_CONTACTS,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.WRITE_CALL_LOG,
            Manifest.permission.READ_SMS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH,
            Manifest.permission.POST_NOTIFICATIONS,
    };
    private static final String[] FORBIDDEN_PACKAGES = {
            "com.android.contacts",
            "com.android.dialer",
            "com.android.launcher3",
            "com.android.messaging",
            "com.google.android.apps.messaging",
            "com.google.android.apps.nexuslauncher",
            "com.google.android.dialer",
            "org.lineageos.trebuchet",
    };

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private ApplicationInfo appInfo() throws PackageManager.NameNotFoundException {
        Context context = context();
        return context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
    }

    private String resolveHomePackage() {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        ResolveInfo resolved = context().getPackageManager()
                .resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        assertNotNull(resolved);
        return resolved.activityInfo.packageName;
    }

    private String resolveDialerPackage() {
        TelecomManager telecomManager = (TelecomManager) context().getSystemService(Context.TELECOM_SERVICE);
        assertNotNull(telecomManager);
        return telecomManager.getDefaultDialerPackage();
    }

    private String resolveSmsPackage() {
        return Telephony.Sms.getDefaultSmsPackage(context());
    }

    private String resolveAssistantPackage() {
        String assistant = Settings.Secure.getString(context().getContentResolver(), "assistant");
        assertNotNull(assistant);
        ComponentName componentName = ComponentName.unflattenFromString(assistant);
        assertNotNull(componentName);
        return componentName.getPackageName();
    }

    private void assumeSystemEliza() throws PackageManager.NameNotFoundException {
        ApplicationInfo info = appInfo();
        assumeTrue("ElizaOS tests only run for the system privileged Eliza APK",
                info.sourceDir != null && info.sourceDir.startsWith("/system/priv-app/Eliza/"));
    }

    @Test
    public void packageIsPrivilegedSystemEliza() throws Exception {
        assumeSystemEliza();
        ApplicationInfo info = appInfo();

        assertEquals(PACKAGE_NAME, context().getPackageName());
        assertTrue((info.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
        assertTrue(info.sourceDir.startsWith("/system/priv-app/Eliza/"));
    }

    @Test
    public void homeIntentResolvesToEliza() throws Exception {
        assumeSystemEliza();
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);

        assertNotNull(context().getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY));
        assertEquals(PACKAGE_NAME, resolveHomePackage());
    }

    @Test
    public void elizaHoldsAndroidDefaultRoles() throws Exception {
        assumeSystemEliza();
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        RoleManager roleManager = (RoleManager) context().getSystemService(Context.ROLE_SERVICE);
        assertNotNull(roleManager);

        assertTrue(RoleManager.ROLE_HOME + " must be available", roleManager.isRoleAvailable(RoleManager.ROLE_HOME));
        assertTrue(RoleManager.ROLE_DIALER + " must be available", roleManager.isRoleAvailable(RoleManager.ROLE_DIALER));
        assertTrue(RoleManager.ROLE_SMS + " must be available", roleManager.isRoleAvailable(RoleManager.ROLE_SMS));
        assertTrue(RoleManager.ROLE_ASSISTANT + " must be available", roleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT));

        assertEquals(PACKAGE_NAME, resolveHomePackage());
        assertEquals(PACKAGE_NAME, resolveDialerPackage());
        assertEquals(PACKAGE_NAME, resolveSmsPackage());
        assertEquals(PACKAGE_NAME, resolveAssistantPackage());
    }

    @Test
    public void defaultPermissionsAreGranted() throws Exception {
        assumeSystemEliza();
        for (String permission : REQUIRED_PERMISSIONS) {
            assertEquals(
                    permission,
                    PackageManager.PERMISSION_GRANTED,
                    context().checkSelfPermission(permission)
            );
        }
    }

    @Test
    public void stockPhoneAppsAreNotInstalled() throws Exception {
        assumeSystemEliza();
        PackageManager packageManager = context().getPackageManager();
        for (String packageName : FORBIDDEN_PACKAGES) {
            try {
                packageManager.getPackageInfo(packageName, 0);
                throw new AssertionError(packageName + " is still installed");
            } catch (PackageManager.NameNotFoundException expected) {
                assertTrue(true);
            }
        }
    }
}

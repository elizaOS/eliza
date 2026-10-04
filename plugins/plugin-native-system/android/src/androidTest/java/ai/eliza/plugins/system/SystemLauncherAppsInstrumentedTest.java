package ai.eliza.plugins.system;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Arrays;
import java.util.HashSet;
import org.junit.Test;
import static org.junit.Assert.*;

public final class SystemLauncherAppsInstrumentedTest {
    private ResolveInfo entry(String name) {
        ResolveInfo result = new ResolveInfo();
        result.activityInfo = new ActivityInfo();
        result.activityInfo.packageName = name;
        result.activityInfo.exported = true;
        result.activityInfo.enabled = true;
        result.activityInfo.applicationInfo = new ApplicationInfo();
        result.activityInfo.applicationInfo.enabled = true;
        return result;
    }

    @Test public void rejectsSelfDisabledUnexportedAndMalformedActivities() {
        ResolveInfo self = entry("host"), hidden = entry("hidden"), disabled = entry("disabled"),
            disabledApp = entry("disabled.app"), valid = entry("visible");
        hidden.activityInfo.exported = false;
        disabled.activityInfo.enabled = false;
        disabledApp.activityInfo.applicationInfo.enabled = false;
        assertEquals(Arrays.asList(valid), SystemLauncherApps.eligible(
            Arrays.asList(null, new ResolveInfo(), self, hidden, disabled, disabledApp, valid), "host"));
    }

    @Test public void sortsLabelsAndDeduplicatesPackagesWithoutMutatingCandidates() {
        ResolveInfo first = entry("one"), duplicate = entry("one"), second = entry("two");
        first.nonLocalizedLabel = "Zulu";
        duplicate.nonLocalizedLabel = "Alpha";
        second.nonLocalizedLabel = "Beta";
        java.util.List<ResolveInfo> candidates = Arrays.asList(first, second, duplicate);
        java.util.List<SystemLauncherApps.App> apps = SystemLauncherApps.describe(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager(),
            candidates, "host");
        assertEquals(2, apps.size());
        assertEquals("one", apps.get(0).packageName);
        assertEquals("Alpha", apps.get(0).label);
        assertEquals("two", apps.get(1).packageName);
        assertSame(first, candidates.get(0));
    }

    @Test public void realDiscoveryAndResolutionNeverLaunchAnActivity() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        HashSet<String> names = new HashSet<>();
        for (SystemLauncherApps.App app : SystemLauncherApps.list(context)) {
            assertTrue(names.add(app.packageName));
            assertNotEquals(context.getPackageName(), app.packageName);
            assertNotNull(app.label);
            Intent intent = SystemLauncherApps.launchIntent(context, app.packageName);
            // A package may be removed between discovery and resolution.
            if (intent != null) assertEquals(app.packageName, intent.getComponent().getPackageName());
        }
        assertNull(SystemLauncherApps.launchIntent(context, "invalid.missing.launcher.fixture"));
        for (String invalid : new String[]{null, "", context.getPackageName()}) {
            try { SystemLauncherApps.launchIntent(context, invalid); fail("Invalid target admitted"); }
            catch (IllegalArgumentException expected) { /* Explicit refusal. */ }
        }
    }
}

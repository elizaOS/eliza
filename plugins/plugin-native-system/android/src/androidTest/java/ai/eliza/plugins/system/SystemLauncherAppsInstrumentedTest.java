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
        result.activityInfo.name = name + ".MainActivity";
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
        java.util.List<SystemLauncherApps.App> installed = SystemLauncherApps.list(context);
        assertFalse("The consumer manifest must expose installed launcher apps", installed.isEmpty());
        for (SystemLauncherApps.App app : installed) {
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

    @Test public void defaultHandlerExcludesTheHostAndReportsAChooserWithoutAPackage() {
        ResolveInfo self = entry("host"), dialer = entry("dialer"), other = entry("other.dialer"), resolver = entry("android");
        assertFalse("No handler", SystemLauncherApps.chooseDefault(null, Arrays.asList(), "host", null).available);
        assertFalse("Only the host handles it", SystemLauncherApps.chooseDefault(self, Arrays.asList(self), "host", "Host").available);
        SystemLauncherApps.DefaultHandler single = SystemLauncherApps.chooseDefault(dialer, Arrays.asList(dialer), "host", "Phone");
        assertTrue(single.available);
        assertEquals("dialer", single.packageName);
        assertEquals("Phone", single.label);
        SystemLauncherApps.DefaultHandler chooser = SystemLauncherApps.chooseDefault(resolver, Arrays.asList(dialer, other), "host", "Open with");
        assertTrue(chooser.available);
        assertNull("A chooser names no package", chooser.packageName);
        SystemLauncherApps.DefaultHandler hostPreferred = SystemLauncherApps.chooseDefault(self, Arrays.asList(self, dialer), "host", "Host");
        assertTrue(hostPreferred.available);
        assertNull("The host is never reported as the handler", hostPreferred.packageName);
    }

    @Test public void realDialResolutionCarriesNoDataAndUnknownRolesAreRefused() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent dial = SystemLauncherApps.roleIntent("dial");
        assertEquals(Intent.ACTION_DIAL, dial.getAction());
        assertEquals("tel:", dial.getDataString());
        assertNull(dial.getExtras());
        SystemLauncherApps.DefaultHandler handler = SystemLauncherApps.resolveDefault(context, "dial");
        if (handler.packageName != null) assertNotEquals(context.getPackageName(), handler.packageName);
        Intent handoff = SystemLauncherApps.defaultLaunchIntent(context, "dial");
        if (handoff != null && handoff.getComponent() != null)
            assertNotEquals(context.getPackageName(), handoff.getComponent().getPackageName());
        String expected = InstrumentationRegistry.getArguments().getString("launcherExpectedDialerPackage");
        if (expected != null) {
            assertTrue("The installed dialer must be available to the consumer", handler.available);
            assertEquals(expected, handler.packageName);
            assertNotNull(handoff);
            assertEquals(expected, handoff.getComponent().getPackageName());
        }
        assertNull(SystemLauncherApps.roleIntent("sms"));
        try { SystemLauncherApps.resolveDefault(context, "camera"); fail("Unknown role admitted"); }
        catch (IllegalArgumentException expected) { /* Explicit refusal. */ }
    }

    @Test public void handoffCannotReenterTheHostOrSelectADisabledDefault() {
        ResolveInfo self = entry("host"), first = entry("dialer.one"), second = entry("dialer.two");
        ResolveInfo disabled = entry("disabled");
        disabled.activityInfo.enabled = false;
        java.util.List<ResolveInfo> handlers = Arrays.asList(self, first, second, disabled);
        Intent handoff = SystemLauncherApps.chooseLaunchIntent(SystemLauncherApps.roleIntent("dial"), self, handlers, "host");
        assertEquals(Intent.ACTION_CHOOSER, handoff.getAction());
        Intent initial = handoff.getParcelableExtra(Intent.EXTRA_INTENT);
        assertEquals("dialer.one", initial.getComponent().getPackageName());
        android.os.Parcelable[] rest = handoff.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS);
        assertEquals(1, rest.length);
        assertEquals("dialer.two", ((Intent) rest[0]).getComponent().getPackageName());
        assertNull(SystemLauncherApps.chooseDefault(disabled, handlers, "host", "Disabled").packageName);
        assertEquals("dialer.two", SystemLauncherApps.chooseLaunchIntent(SystemLauncherApps.roleIntent("dial"), second, handlers, "host").getComponent().getPackageName());
        assertNull(SystemLauncherApps.chooseLaunchIntent(SystemLauncherApps.roleIntent("dial"), self, Arrays.asList(self, disabled), "host"));
    }

    @Test public void iconsRenderAsBoundedPngsAndMissingPackagesHaveNone() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        byte[] png = SystemLauncherApps.iconPng(context.getPackageManager(), context.getPackageName(), 48);
        assertNotNull(png);
        assertEquals((byte) 0x89, png[0]);
        assertEquals((byte) 'P', png[1]);
        assertNull(SystemLauncherApps.iconPng(context.getPackageManager(), "invalid.missing.launcher.fixture", 48));
        assertNull(SystemLauncherApps.iconPng(context.getPackageManager(), context.getPackageName(), 4096));
    }
}

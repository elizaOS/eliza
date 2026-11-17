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

    @Test public void sortsLabelsAndKeepsOneEntryPerComponentWithoutMutatingCandidates() {
        ResolveInfo first = entry("one"), duplicate = entry("one"), second = entry("two"), sibling = entry("two");
        first.nonLocalizedLabel = "Zulu";
        duplicate.nonLocalizedLabel = "Alpha";
        second.nonLocalizedLabel = "Beta";
        sibling.activityInfo.name = "two.Second";
        sibling.nonLocalizedLabel = "Gamma";
        java.util.List<ResolveInfo> candidates = Arrays.asList(first, second, duplicate, sibling);
        java.util.List<SystemLauncherApps.App> apps = SystemLauncherApps.describe(
            InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager(),
            candidates, "host");
        assertEquals(3, apps.size());
        assertEquals("one", apps.get(0).packageName);
        assertEquals("Alpha", apps.get(0).label);
        assertEquals("two", apps.get(1).packageName);
        assertEquals("two.MainActivity", apps.get(1).activityName);
        assertEquals("two.Second", apps.get(2).activityName);
        for (SystemLauncherApps.App app : apps) {
            assertNull(app.user);
            assertNull(app.profile);
            assertFalse(app.locked);
        }
        assertNotNull(SystemLauncherApps.find(apps, "two", "two.Second", null));
        assertNull("Another profile's entry is a different identity", SystemLauncherApps.find(apps, "two", "two.Second", "10"));
        assertNull(SystemLauncherApps.find(apps, "two", "two.Missing", null));
        assertSame(first, candidates.get(0));
    }

    @Test public void exactResolutionRefusesStaleEntriesWithStableCodes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SystemLauncherApps.App own = null;
        for (SystemLauncherApps.App app : SystemLauncherApps.list(context)) if (app.user == null) { own = app; break; }
        assertNotNull("The consumer manifest must expose installed launcher apps", own);
        SystemLauncherApps.Target target = SystemLauncherApps.resolve(context, own.packageName, own.activityName, null);
        assertNull(target.user);
        Intent intent = SystemLauncherApps.launchIntent(target.component);
        assertEquals(own.packageName, intent.getComponent().getPackageName());
        assertEquals(own.activityName, intent.getComponent().getClassName());
        assertTrue((intent.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
        String[][] refused = {
            {"invalid.missing.launcher.fixture", "invalid.missing.launcher.fixture.Main", null, SystemLauncherApps.NOT_INSTALLED},
            {own.packageName, own.activityName + "Gone", null, SystemLauncherApps.NO_LAUNCHER},
            {own.packageName, SystemLauncherApps.APP_DETAILS_ACTIVITY, null, SystemLauncherApps.NO_LAUNCHER},
            {own.packageName, own.activityName, "999999999", SystemLauncherApps.PROFILE_UNAVAILABLE},
        };
        for (String[] item : refused) {
            try { SystemLauncherApps.resolve(context, item[0], item[1], item[2]); fail("A stale entry resolved"); }
            catch (SystemLauncherApps.Refusal refusal) { assertEquals(item[3], refusal.code); assertFalse(refusal.getMessage().isEmpty()); }
        }
        for (String[] bad : new String[][]{{null, "a.B"}, {"", "a.B"}, {own.packageName, null}, {own.packageName, ""},
            {context.getPackageName(), context.getPackageName() + ".Main"}, {own.packageName, own.activityName, "not-a-serial"}}) {
            try { SystemLauncherApps.resolve(context, bad[0], bad[1], bad.length > 2 ? bad[2] : null); fail("Malformed request admitted"); }
            catch (IllegalArgumentException expected) { /* Explicit refusal. */ }
        }
        assertFalse("The host's own copy in another profile is never listed",
            SystemLauncherApps.listable(new android.content.ComponentName(context.getPackageName(), "x.Main"), context.getPackageName()));
        assertFalse(SystemLauncherApps.listable(new android.content.ComponentName("a", SystemLauncherApps.APP_DETAILS_ACTIVITY), "host"));
        assertFalse(SystemLauncherApps.listable(null, "host"));
        assertEquals("work", SystemLauncherApps.profileKind("android.os.usertype.profile.MANAGED"));
        assertEquals("private", SystemLauncherApps.profileKind("android.os.usertype.profile.PRIVATE"));
        assertEquals("clone", SystemLauncherApps.profileKind("android.os.usertype.profile.CLONE"));
        assertEquals("other", SystemLauncherApps.profileKind("android.os.usertype.full.SECONDARY"));
    }

    @Test public void watchingRegistersAndClosesWithoutReportingTheHost() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        java.util.List<String> reports = new java.util.ArrayList<>();
        AutoCloseable watch = SystemLauncherApps.watch(context, (name, reason) -> reports.add(name + ":" + reason));
        watch.close();
        watch.close();
        assertTrue(reports.isEmpty());
    }

    @Test public void realDiscoveryAndResolutionNeverLaunchAnActivity() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        HashSet<String> names = new HashSet<>();
        java.util.List<SystemLauncherApps.App> installed = SystemLauncherApps.list(context);
        assertFalse("The consumer manifest must expose installed launcher apps", installed.isEmpty());
        for (SystemLauncherApps.App app : installed) {
            assertTrue(names.add(app.key()));
            assertFalse(app.activityName.isEmpty());
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
        String expectedPackage = InstrumentationRegistry.getArguments().getString("launcherExpectedDialerPackage");
        if (expectedPackage != null) {
            assertTrue("The installed dialer must be available to the consumer", handler.available);
            assertEquals(expectedPackage, handler.packageName);
            assertNotNull(handoff);
            assertEquals(expectedPackage, handoff.getComponent().getPackageName());
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

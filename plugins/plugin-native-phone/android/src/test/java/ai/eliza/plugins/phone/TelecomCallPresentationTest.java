/** Exercises what the call screen says and offers for each Telecom state, without Android views. */
package ai.eliza.plugins.phone;

import static org.junit.Assert.assertEquals;
import android.telecom.Call;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.os.Looper;
import java.lang.reflect.Constructor;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
@LooperMode(LooperMode.Mode.PAUSED)
public class TelecomCallPresentationTest {
    private static List<String> offered(int state, boolean audioKnown, boolean speakerRoutable, boolean canHold) {
        TelecomCallPresentation.Controls controls = TelecomCallPresentation.controls(state, audioKnown, speakerRoutable, canHold);
        List<String> names = new ArrayList<>();
        if (controls.answer) names.add("answer");
        if (controls.decline) names.add("decline");
        if (controls.mute) names.add("mute");
        if (controls.keypad) names.add("keypad");
        if (controls.speaker) names.add("speaker");
        if (controls.hold) names.add("hold");
        if (controls.end) names.add("end");
        return names;
    }

    @Test public void initialsAreTheFirstAndLastWordsLetters() {
        assertEquals("AL", TelecomCallPresentation.initials("Ada Lovelace", true));
        assertEquals("AL", TelecomCallPresentation.initials("  ada   king  lovelace ", true));
        assertEquals("A", TelecomCallPresentation.initials("Ada", false));
        assertEquals("DL", TelecomCallPresentation.initials("Dr. Ada M. Lovelace", true));
        assertEquals("ÉM", TelecomCallPresentation.initials("émilie (work) martin", true));
        assertEquals("林", TelecomCallPresentation.initials("林小明", true));
        assertEquals("I", TelecomCallPresentation.initials("411 Info", true));
    }

    @Test public void aNumberWithNoNameIsAHashAndAWithheldCallerIsBlank() {
        assertEquals("#", TelecomCallPresentation.initials(null, true));
        assertEquals("#", TelecomCallPresentation.initials("+1 555 0123", true));
        assertEquals("", TelecomCallPresentation.initials(null, false));
        assertEquals("", TelecomCallPresentation.initials("   ", false));
    }

    @Test public void elapsedTimeGainsAnHourFieldOnlyFromOneHour() {
        assertEquals("0:00", TelecomCallPresentation.elapsed(0));
        assertEquals("0:00", TelecomCallPresentation.elapsed(999));
        assertEquals("0:01", TelecomCallPresentation.elapsed(1000));
        assertEquals("1:05", TelecomCallPresentation.elapsed(65_000));
        assertEquals("59:59", TelecomCallPresentation.elapsed(3_599_999));
        assertEquals("1:00:00", TelecomCallPresentation.elapsed(3_600_000));
        assertEquals("12:03:09", TelecomCallPresentation.elapsed(43_389_000));
        assertEquals("0:00", TelecomCallPresentation.elapsed(-5000));
    }

    @Test public void secondaryLineFollowsTheCallState() {
        assertEquals("(555) 010-0123", TelecomCallPresentation.secondaryLine(Call.STATE_RINGING, "(555) 010-0123", 0, 9000));
        assertEquals("", TelecomCallPresentation.secondaryLine(Call.STATE_RINGING, null, 0, 9000));
        for (int calling : new int[] {Call.STATE_NEW, Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT}) {
            assertEquals("Calling…", TelecomCallPresentation.secondaryLine(calling, "(555) 010-0123", 0, 9000));
        }
        assertEquals("1:15", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, "(555) 010-0123", 5000, 80_000));
        // The clock moved back after the call connected.
        assertEquals("0:00", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, null, 5000, 4000));
        // Telecom has not reported a connect time: no invented duration.
        assertEquals("", TelecomCallPresentation.secondaryLine(Call.STATE_ACTIVE, null, 0, 80_000));
        assertEquals("On hold", TelecomCallPresentation.secondaryLine(Call.STATE_HOLDING, null, 5000, 80_000));
        assertEquals("Call ended", TelecomCallPresentation.secondaryLine(Call.STATE_DISCONNECTING, null, 5000, 80_000));
        assertEquals("Call ended", TelecomCallPresentation.secondaryLine(Call.STATE_DISCONNECTED, null, 5000, 80_000));
    }

    @Test public void timerTicksOnTheCallsOwnSecondBoundary() {
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(5000, 5000));
        assertEquals(750, TelecomCallPresentation.untilNextSecond(5000, 6250));
        assertEquals(1, TelecomCallPresentation.untilNextSecond(5000, 6999));
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(0, 6250));
        assertEquals(1000, TelecomCallPresentation.untilNextSecond(5000, 4000));
    }

    @Test public void aRingingCallOffersOnlyAnswerAndDecline() {
        assertEquals(Arrays.asList("answer", "decline"), offered(Call.STATE_RINGING, true, true, true));
        assertEquals(Arrays.asList("answer", "decline"), offered(Call.STATE_RINGING, false, false, false));
    }

    @Test public void aLiveCallOffersEachControlOnlyWhenItCanWork() {
        assertEquals(Arrays.asList("mute", "keypad", "speaker", "hold", "end"), offered(Call.STATE_ACTIVE, true, true, true));
        assertEquals(Arrays.asList("keypad", "end"), offered(Call.STATE_ACTIVE, false, true, false));
        assertEquals(Arrays.asList("mute", "keypad", "end"), offered(Call.STATE_ACTIVE, true, false, false));
        // The keypad sends tones only into a connected call.
        assertEquals(Arrays.asList("mute", "speaker", "hold", "end"), offered(Call.STATE_HOLDING, true, true, true));
        assertEquals(Arrays.asList("mute", "speaker", "end"), offered(Call.STATE_DIALING, true, true, false));
        assertEquals(Arrays.asList("end"), offered(Call.STATE_CONNECTING, false, false, false));
    }

    @Test public void anEndedCallOffersNothing() {
        assertEquals(Arrays.asList(), offered(Call.STATE_DISCONNECTING, true, true, true));
        assertEquals(Arrays.asList(), offered(Call.STATE_DISCONNECTED, true, true, true));
    }

    @Test public void chipsAndTogglesSayTheirState() {
        assertEquals("Ada Lovelace · On hold", TelecomCallPresentation.chipLabel("Ada Lovelace", Call.STATE_HOLDING));
        assertEquals("Unknown · Incoming", TelecomCallPresentation.chipLabel("Unknown", Call.STATE_RINGING));
        assertEquals("(555) 010-0123 · Active", TelecomCallPresentation.chipLabel("(555) 010-0123", Call.STATE_ACTIVE));
        assertEquals("Ada · Calling…", TelecomCallPresentation.chipLabel("Ada", Call.STATE_DIALING));
        assertEquals("Ada · Call ended", TelecomCallPresentation.chipLabel("Ada", Call.STATE_DISCONNECTED));
        assertEquals("Mute, on", TelecomCallPresentation.toggleDescription("Mute", true));
        assertEquals("Speaker, off", TelecomCallPresentation.toggleDescription("Speaker", false));
    }

    public static class CallOwner extends TelecomCallService {
        @Override protected TelecomCallConfiguration configuration() {
            return new TelecomCallConfiguration("ownership-test", "Call review", "reviewcall", Activity.class);
        }
    }

    public static class IconOwner extends TelecomCallService {
        @Override protected TelecomCallConfiguration configuration() {
            return new TelecomCallConfiguration("icon-test", "Call review", "reviewcall", Activity.class, android.R.drawable.ic_dialog_info);
        }
    }

    @Test public void callNotificationUsesTheHostIconAndKeepsThePlatformGlyphWithoutOne() throws Exception {
        int[] expected = {android.R.drawable.sym_action_call, android.R.drawable.ic_dialog_info};
        List<Class<? extends TelecomCallService>> owners = Arrays.asList(CallOwner.class, IconOwner.class);
        for (int i = 0; i < expected.length; i++) {
            TelecomCallService owner = Robolectric.buildService(owners.get(i)).create().get();
            try {
                owner.onCallAdded(activeCall());
                Notification notice = owner.getSystemService(NotificationManager.class).getActiveNotifications()[0].getNotification();
                assertEquals(expected[i], notice.getSmallIcon().getResId());
                // A call with no handle names nobody.
                assertEquals("Unknown caller", notice.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
            } finally { owner.onDestroy(); }
        }
    }

    private static Call activeCall() throws Exception {
        // API 35's actual Call constructor initializes Android's callback registry.
        for (Constructor<?> constructor : Call.class.getDeclaredConstructors()) {
            if (constructor.getParameterCount() != 5) continue;
            constructor.setAccessible(true);
            Call call = (Call) constructor.newInstance(null, "owned-call", null, "test", 0);
            ReflectionHelpers.setField(call, "mState", Call.STATE_ACTIVE);
            return call;
        }
        throw new AssertionError("API 35 Call constructor not found");
    }

    public static final class HeldContacts extends android.content.ContentProvider {
        static java.util.concurrent.CountDownLatch entered, release;
        @Override public boolean onCreate() { return true; }
        @Override public android.database.Cursor query(android.net.Uri uri, String[] columns, String selection, String[] args, String order) {
            entered.countDown();
            try { if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("Contact fixture was not released"); }
            catch (InterruptedException stopped) { Thread.currentThread().interrupt(); return null; }
            android.database.MatrixCursor rows = new android.database.MatrixCursor(columns);
            rows.addRow(new Object[] {"Private contact name"}); return rows;
        }
        @Override public String getType(android.net.Uri uri) { return null; }
        @Override public android.net.Uri insert(android.net.Uri uri, android.content.ContentValues values) { throw new UnsupportedOperationException(); }
        @Override public int delete(android.net.Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
        @Override public int update(android.net.Uri uri, android.content.ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    }

    private static Call contactCall() throws Exception {
        Call call = activeCall();
        for (Constructor<?> constructor : Call.Details.class.getDeclaredConstructors()) {
            Object[] args = new Object[constructor.getParameterCount()];
            Class<?>[] types = constructor.getParameterTypes();
            for (int i = 0; i < types.length; i++) {
                if (types[i] == int.class) args[i] = 0;
                else if (types[i] == long.class) args[i] = 0L;
                else if (types[i] == boolean.class) args[i] = false;
            }
            try {
                constructor.setAccessible(true);
                Call.Details details = (Call.Details) constructor.newInstance(args);
                ReflectionHelpers.setField(details, "mHandle", android.net.Uri.parse("tel:+15555550100"));
                ReflectionHelpers.setField(call, "mDetails", details); return call;
            } catch (ReflectiveOperationException unavailable) { /* Try another framework constructor. */ }
        }
        throw new AssertionError("Android Call.Details constructor unavailable");
    }

    @Test public void revokedContactsPermissionFencesAnAlreadyRunningNameLookup() throws Exception { contactLookup("revoked"); }
    @Test public void removedCallFencesAnAlreadyRunningNameLookup() throws Exception { contactLookup("removed"); }
    @Test public void destroyedServiceFencesAnAlreadyRunningNameLookup() throws Exception { contactLookup("destroyed"); }
    @Test public void cachedContactNameIsNotReusedAfterPermissionWithdrawal() throws Exception { contactLookup("cached"); }
    private static void contactLookup(String retirement) throws Exception {
        android.app.Application app = org.robolectric.RuntimeEnvironment.getApplication();
        Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.READ_CONTACTS);
        HeldContacts.entered = new java.util.concurrent.CountDownLatch(1);
        HeldContacts.release = new java.util.concurrent.CountDownLatch(1);
        android.content.pm.ProviderInfo info = new android.content.pm.ProviderInfo(); info.authority = "com.android.contacts";
        Robolectric.buildContentProvider(HeldContacts.class).create(info);
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        boolean destroyed = false;
        try {
            Call call = contactCall(); owner.onCallAdded(call);
            org.junit.Assert.assertTrue(HeldContacts.entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
            java.util.concurrent.ExecutorService worker = ReflectionHelpers.getField(owner, "lookups");
            if (retirement.equals("revoked")) Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.READ_CONTACTS);
            if (retirement.equals("removed")) owner.onCallRemoved(call);
            if (retirement.equals("destroyed")) { owner.onDestroy(); destroyed = true; }
            HeldContacts.release.countDown();
            if (!destroyed) worker.submit(() -> {}).get(10, java.util.concurrent.TimeUnit.SECONDS);
            else org.junit.Assert.assertTrue(worker.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            if (retirement.equals("cached")) {
                assertEquals("Private contact name", owner.getSystemService(NotificationManager.class).getActiveNotifications()[0].getNotification().extras.getCharSequence(Notification.EXTRA_TITLE).toString());
                Shadows.shadowOf(app).denyPermissions(android.Manifest.permission.READ_CONTACTS);
                queueState(call); Shadows.shadowOf(Looper.getMainLooper()).idle();
            }
            android.service.notification.StatusBarNotification[] notices = owner.getSystemService(NotificationManager.class).getActiveNotifications();
            if (retirement.equals("revoked") || retirement.equals("cached")) {
                assertEquals(1, notices.length);
                assertEquals("+15555550100", notices[0].getNotification().extras.getCharSequence(Notification.EXTRA_TITLE).toString());
            } else assertEquals(0, notices.length);
        } finally {
            HeldContacts.release.countDown();
            if (!destroyed) owner.onDestroy();
        }
    }

    private static void queueState(Call call) {
        // This is Android's asynchronous callback dispatcher, not a fake callback.
        ReflectionHelpers.callInstanceMethod(call, "fireStateChanged", ClassParameter.from(int.class, call.getState()));
    }

    @Test public void removedCallCannotRepublishAnAlreadyQueuedStateCallback() throws Exception {
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        try {
            Call call = activeCall();
            owner.onCallAdded(call);
            NotificationManager notifications = owner.getSystemService(NotificationManager.class);
            org.junit.Assert.assertEquals(1, notifications.getActiveNotifications().length);
            queueState(call);
            owner.onCallRemoved(call);
            org.junit.Assert.assertEquals(0, notifications.getActiveNotifications().length);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            org.junit.Assert.assertEquals(0, notifications.getActiveNotifications().length);
            org.junit.Assert.assertFalse(TelecomCallService.answerCall("missing", 0));
            org.junit.Assert.assertFalse(TelecomCallService.disconnectCall("missing"));
        } finally { owner.onDestroy(); }
    }

    @Test public void removedCallCannotRepublishAnAlreadyQueuedDetailsCallback() throws Exception {
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        try {
            Call call = activeCall();
            owner.onCallAdded(call);
            ReflectionHelpers.callInstanceMethod(call, "fireDetailsChanged", ClassParameter.from(Call.Details.class, null));
            owner.onCallRemoved(call);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            org.junit.Assert.assertEquals(0, owner.getSystemService(NotificationManager.class).getActiveNotifications().length);
        } finally { owner.onDestroy(); }
    }

    @Test public void destroyedOwnerCannotRepublishAnAlreadyQueuedCall() throws Exception {
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        Call call = activeCall();
        owner.onCallAdded(call);
        queueState(call);
        owner.onDestroy();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        org.junit.Assert.assertTrue(TelecomCallService.callIds().isEmpty());
        org.junit.Assert.assertEquals(0, owner.getSystemService(NotificationManager.class).getActiveNotifications().length);
    }

    @Test public void removingOneCallRetainsTheOtherCallAndItsNotification() throws Exception {
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        try {
            Call first = activeCall(), second = activeCall();
            owner.onCallAdded(first); owner.onCallAdded(second);
            org.junit.Assert.assertEquals(2, TelecomCallService.callIds().size());
            queueState(first); owner.onCallRemoved(first);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            org.junit.Assert.assertEquals(1, TelecomCallService.callIds().size());
            org.junit.Assert.assertSame(second, TelecomCallService.call(TelecomCallService.callIds().get(0)));
            org.junit.Assert.assertEquals(1, owner.getSystemService(NotificationManager.class).getActiveNotifications().length);
        } finally { owner.onDestroy(); }
    }

    @Test public void currentCallStillPublishesItsNativeStateChange() throws Exception {
        CallOwner owner = Robolectric.buildService(CallOwner.class).create().get();
        try {
            Call call = activeCall(); owner.onCallAdded(call);
            ReflectionHelpers.setField(call, "mState", Call.STATE_HOLDING); queueState(call);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            NotificationManager notifications = owner.getSystemService(NotificationManager.class);
            org.junit.Assert.assertEquals(1, notifications.getActiveNotifications().length);
            Notification notification = notifications.getActiveNotifications()[0].getNotification();
            org.junit.Assert.assertEquals("On hold", notification.extras.getString(Notification.EXTRA_TEXT));
        } finally { owner.onDestroy(); }
    }
}

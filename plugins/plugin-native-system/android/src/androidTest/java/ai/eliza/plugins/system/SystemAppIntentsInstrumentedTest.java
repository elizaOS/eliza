package ai.eliza.plugins.system;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.provider.MediaStore;
import android.provider.Telephony;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Android intent semantics with captured dispatch; never opens apps or sends messages. */
public final class SystemAppIntentsInstrumentedTest {
    @Test public void phoneOnlyOpensTheDialerAndMessagesFollowAndroidDefault() {
        Intent phone = SystemAppIntents.phone();
        assertEquals(Intent.ACTION_DIAL, phone.getAction());
        assertNull(phone.getData());
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = Telephony.Sms.getDefaultSmsPackage(context);
        Intent expected = name == null ? null : context.getPackageManager().getLaunchIntentForPackage(name);
        if (expected == null) expected = Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_MESSAGING);
        assertTrue(expected.filterEquals(SystemAppIntents.messages(context)));
    }

    @Test public void availableGalleryDispatchesOnce() {
        List<Intent> seen = new ArrayList<>();
        SystemAppIntents.PhotoResult result = SystemAppIntents.openPhotos(seen::add);
        assertEquals(SystemAppIntents.PhotoStatus.DISPATCHED, result.status);
        assertNull(result.error);
        assertEquals(1, seen.size());
        assertTrue(Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_GALLERY).filterEquals(seen.get(0)));
    }

    @Test public void missingGalleryFallsBackToImagesOnce() {
        List<Intent> seen = new ArrayList<>();
        SystemAppIntents.PhotoResult result = SystemAppIntents.openPhotos(intent -> {
            seen.add(intent);
            if (seen.size() == 1) throw new ActivityNotFoundException();
        });
        assertEquals(SystemAppIntents.PhotoStatus.DISPATCHED, result.status);
        assertEquals(2, seen.size());
        assertEquals(Intent.ACTION_VIEW, seen.get(1).getAction());
        assertEquals("image/*", seen.get(1).getType());
        assertEquals(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, seen.get(1).getData());
    }

    @Test public void galleryDenialDoesNotTryAnotherDestination() {
        List<Intent> seen = new ArrayList<>();
        SecurityException denied = new SecurityException("denied");
        SystemAppIntents.PhotoResult result = SystemAppIntents.openPhotos(intent -> { seen.add(intent); throw denied; });
        assertEquals(SystemAppIntents.PhotoStatus.DENIED, result.status);
        assertSame(denied, result.error);
        assertEquals(1, seen.size());
    }

    @Test public void fallbackFailuresAreExplicitAndNeverRetried() {
        for (RuntimeException failure : new RuntimeException[]{new ActivityNotFoundException(), new SecurityException()}) {
            List<Intent> seen = new ArrayList<>();
            SystemAppIntents.PhotoResult result = SystemAppIntents.openPhotos(intent -> {
                seen.add(intent);
                if (seen.size() == 1) throw new ActivityNotFoundException();
                throw failure;
            });
            assertEquals(SystemAppIntents.PhotoStatus.UNAVAILABLE, result.status);
            assertSame(failure, result.error);
            assertEquals(2, seen.size());
        }
    }

    @Test public void unexpectedHostFailureIsNotReportedAsAppAbsence() {
        IllegalStateException failure = new IllegalStateException("host state");
        try { SystemAppIntents.openPhotos(intent -> { throw failure; }); fail("Hidden host failure"); }
        catch (IllegalStateException actual) { assertSame(failure, actual); }
    }
}

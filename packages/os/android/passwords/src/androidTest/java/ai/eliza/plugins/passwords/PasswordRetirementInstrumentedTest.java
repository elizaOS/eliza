package ai.eliza.plugins.passwords;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import static org.junit.Assert.*;

public final class PasswordRetirementInstrumentedTest {
  @Test public void queuedDeliveryRequiresTheOriginalTicketAndCurrentOwner() throws Exception {
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    var access = PasswordVaultAccess.get(context);
    AtomicBoolean ownerAdmitted = new AtomicBoolean(true);
    AtomicInteger deliveries = new AtomicInteger();
    PasswordVaultAccess.setAdmission(ignored -> ownerAdmitted.get());
    try {
      long original = access.begin();
      assertTrue(access.complete(original, true));
      ownerAdmitted.set(false);
      try {
        access.useForOwner(context, original, ignored -> deliveries.incrementAndGet());
        fail("Retired owner delivered a queued secret");
      } catch (PasswordVaultAccess.NotAdmitted expected) { }
      access.lockAndClose();
      ownerAdmitted.set(true);
      long replacement = access.begin();
      assertTrue(access.complete(replacement, true));
      try {
        access.useForOwner(context, original, ignored -> deliveries.incrementAndGet());
        fail("New unlock admitted the old request");
      } catch (PasswordVaultAccess.Locked expected) { }
      access.useForOwner(context, replacement, ignored -> deliveries.incrementAndGet());
      assertEquals(1, deliveries.get());
    } finally {
      access.lockAndClose();
      PasswordVaultAccess.setAdmission(ignored -> true);
    }
  }

  @Test public void focusedRetirementClearsOurClipAndLeavesAReplacementAlone() {
    try (var scenario = ActivityScenario.launch(ClipboardActivity.class)) {
      awaitFocus(scenario);
      scenario.onActivity(activity -> {
        var clipboard = activity.getSystemService(ClipboardManager.class);
        assertNotNull(clipboard);
        SecretSurfaces.copy(activity, "synthetic-clip");
        var own = clipboard.getPrimaryClipDescription();
        assertNotNull(own);
        assertTrue(own.getLabel().toString().startsWith("eliza-passwords-"));
        SecretSurfaces.retireClipboard();
        assertNull(clipboard.getPrimaryClipDescription());
        SecretSurfaces.copy(activity, "synthetic-clip");
        clipboard.setPrimaryClip(ClipData.newPlainText("synthetic-replacement", "synthetic other app content"));
        SecretSurfaces.retireClipboard();
        var replacement = clipboard.getPrimaryClipDescription();
        assertNotNull(replacement);
        assertEquals("synthetic-replacement", replacement.getLabel());
        clipboard.clearPrimaryClip();
      });
    }
  }

  @Test public void lockingDismissesOnlyTheConfirmationOwnedAtRetirement() {
    AtomicInteger cancelled = new AtomicInteger();
    AtomicReference<Runnable> retired = new AtomicReference<>();
    try (var scenario = ActivityScenario.launch(ClipboardActivity.class)) {
      scenario.onActivity(activity -> {
        assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
          () -> fail("A dismissed confirmation cannot copy"), cancelled::incrementAndGet));
        retired.set(SecretSurfaces.currentDismissal());
        retired.get().run();
      });
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      assertEquals(1, cancelled.get());
      scenario.onActivity(activity -> {
        assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_reveal_confirm,
          () -> fail("A dismissed confirmation cannot reveal"), cancelled::incrementAndGet));
        retired.get().run();
      });
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      assertEquals(1, cancelled.get());
      scenario.onActivity(activity -> SecretSurfaces.currentDismissal().run());
      InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      assertEquals(2, cancelled.get());
    }
  }

  private static void awaitFocus(ActivityScenario<ClipboardActivity> scenario) {
    long until = SystemClock.elapsedRealtime() + 5000L;
    var focused = new AtomicBoolean();
    do {
      scenario.onActivity(activity -> focused.set(activity.hasWindowFocus()));
      if (focused.get()) return;
      SystemClock.sleep(50);
    } while (SystemClock.elapsedRealtime() < until);
    fail("Test activity never gained Android clipboard access");
  }

  public static final class ClipboardActivity extends Activity {}
}

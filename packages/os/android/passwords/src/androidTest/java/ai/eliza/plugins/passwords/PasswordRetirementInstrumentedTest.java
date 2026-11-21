package ai.eliza.plugins.passwords;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.SystemClock;
import android.view.View;
import android.view.inspector.WindowInspector;
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

  // spec/os/android/passwords/vault.md, "Native secret delivery checks the current owner and original unlock"
  @Test public void capturedRetirementClosesOnlyItsOwnRevealAndConfirmation() {
    AtomicInteger cancellations = new AtomicInteger();
    Runnable accept = () -> fail("No native action was approved");
    try (var scenario = ActivityScenario.launch(ClipboardActivity.class)) {
      try {
        scenario.onActivity(activity -> {
          SecretSurfaces.dismiss();
          assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
              accept, cancellations::incrementAndGet));
          SecretSurfaces.currentDismissal().run();
        });
        assertSurfaces(cancellations, 1, false);
        scenario.onActivity(activity -> {
          SecretSurfaces.reveal(activity, "Synthetic", "synthetic-reveal");
          Runnable revealRetirement = SecretSurfaces.currentDismissal();
          assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
              accept, cancellations::incrementAndGet));
          revealRetirement.run();
        });
        assertSurfaces(cancellations, 1, true);
        scenario.onActivity(activity -> cancelConfirmation());
        assertSurfaces(cancellations, 2, false);
        scenario.onActivity(activity -> {
          try {
            AutoCloseable reveal = SecretSurfaces.revealOwned(activity, "Synthetic", "synthetic-owned", () -> true);
            assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
                accept, cancellations::incrementAndGet));
            reveal.close();
          } catch (Exception failure) { throw new AssertionError(failure); }
        });
        assertSurfaces(cancellations, 2, true);
        scenario.onActivity(activity -> cancelConfirmation());
        assertSurfaces(cancellations, 3, false);
        scenario.onActivity(activity -> {
          assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
              accept, cancellations::incrementAndGet));
          Runnable previous = SecretSurfaces.currentDismissal();
          SecretSurfaces.dismiss();
          assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
              accept, cancellations::incrementAndGet));
          previous.run();
        });
        assertSurfaces(cancellations, 4, true);
        scenario.onActivity(activity -> SecretSurfaces.dismiss());
        assertSurfaces(cancellations, 5, false);
      } finally {
        scenario.onActivity(activity -> SecretSurfaces.dismiss());
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
      }
    }
  }

  // spec/os/android/passwords/vault.md, "Native secret delivery checks the current owner and original unlock"
  @Test public void stoppingAnotherActivityLeavesCurrentSecretDialogsOpen() {
    AtomicReference<Activity> previous = new AtomicReference<>();
    AtomicInteger cancellations = new AtomicInteger();
    try (var first = ActivityScenario.launch(ClipboardActivity.class)) {
      first.onActivity(previous::set);
      try (var second = ActivityScenario.launch(PasswordEditorInstrumentedTest.Host.class)) {
        try {
          second.onActivity(activity -> {
            assertNotSame(previous.get(), activity);
            SecretSurfaces.reveal(activity, "Synthetic", "synthetic-activity-owner");
            assertTrue(SecretSurfaces.confirm(activity, R.string.eliza_passwords_copy_confirm,
                () -> fail("No native action was approved"), cancellations::incrementAndGet));
            SecretSurfaces.dismiss(previous.get());
            SecretSurfaces.dismiss(null);
          });
          assertSurfaces(cancellations, 0, true);
          second.onActivity(activity -> cancelConfirmation());
          assertSurfaces(cancellations, 1, true);
          second.onActivity(activity -> SecretSurfaces.dismiss(activity));
          assertSurfaces(cancellations, 1, false);
        } finally {
          second.onActivity(activity -> SecretSurfaces.dismiss());
          InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        }
      }
    }
  }

  private static void assertSurfaces(AtomicInteger cancellations, int expected, boolean visible) {
    InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    assertEquals("Only captured confirmations are cancelled", expected, cancellations.get());
    assertEquals("Native surface lifetime follows the remaining dialogs", visible, PasswordSurfaces.visible());
  }

  private static void cancelConfirmation() {
    for (View root : WindowInspector.getGlobalWindowViews()) {
      View cancel = root.findViewById(android.R.id.button2);
      if (cancel == null || !cancel.isShown()) continue;
      assertTrue(cancel.performClick());
      return;
    }
    fail("The current native confirmation has no cancel button");
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

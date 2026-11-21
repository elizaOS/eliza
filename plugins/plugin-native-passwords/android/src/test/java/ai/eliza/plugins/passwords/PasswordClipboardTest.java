package ai.eliza.plugins.passwords;

import org.junit.Test;
import static org.junit.Assert.*;

public final class PasswordClipboardTest {
  private static final class Clipboard implements PasswordClipboard.Platform {
    String label;
    boolean focused = true;
    int clears;
    @Override public CharSequence currentLabel() { return focused ? label : null; }
    @Override public void clear() { label = null; clears++; }
  }

  @Test public void regularBackgroundingPreservesPasteUntilDeadline() {
    PasswordClipboard policy = new PasswordClipboard();
    Clipboard clipboard = new Clipboard();
    clipboard.label = "grace";
    var lease = policy.copied(clipboard, "grace", 45_000);
    clipboard.focused = false;
    policy.clearIfDue(lease, 30_000);
    clipboard.focused = true;
    policy.clearIfDue(lease, 44_999);
    assertEquals("grace", clipboard.label);
    policy.clearIfDue(lease, 45_000);
    assertEquals(1, clipboard.clears);
    assertNull(clipboard.label);
  }

  @Test public void retirementRetriesAtFocusAndNeverClearsADifferentClip() {
    PasswordClipboard policy = new PasswordClipboard();
    Clipboard clipboard = new Clipboard();
    clipboard.label = "grace";
    var retired = policy.copied(clipboard, "grace", 45_000);
    clipboard.focused = false;
    policy.retire(retired, 1);
    assertEquals("grace", clipboard.label);
    clipboard.focused = true;
    policy.clearIfDue(retired, 2);
    assertEquals(1, clipboard.clears);

    clipboard.label = "grace-2";
    var replaced = policy.copied(clipboard, "grace-2", 45_000);
    clipboard.focused = false;
    policy.retire(replaced, 3);
    clipboard.label = "another-app";
    clipboard.focused = true;
    policy.clearIfDue(replaced, 4);
    assertEquals(1, clipboard.clears);
    assertEquals("another-app", clipboard.label);
  }

  @Test public void queuedRetirementAndTimerNeverClearANewerGraceCopy() {
    PasswordClipboard policy = new PasswordClipboard();
    Clipboard clipboard = new Clipboard();
    clipboard.label = "old";
    var old = policy.copied(clipboard, "old", 45_000);
    clipboard.label = "new";
    var current = policy.copied(clipboard, "new", 60_000);
    policy.retire(old, 20_000);
    policy.clearIfDue(old, 45_000);
    assertEquals("new", clipboard.label);
    policy.clearIfDue(current, 60_000);
    assertEquals(1, clipboard.clears);
  }
}

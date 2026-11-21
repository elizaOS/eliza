// spec/os/voice/listener.md, "Only I turn listening on, in an admitted listener with my consent and no exemption"; spec/os/voice/listener.md, "Three crashes while capturing within ten minutes stop listening until I turn it on"
package ai.eliza.sense;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ListenerPolicyTest {
  private static final long NOW = 1_800_000_000_000L;

  @Test public void theIndicatorNotificationCountsOnlyWhenItShowsOnTheLockScreen() {
    assertTrue(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_DEFAULT, false, true));
    assertTrue(ListenerPolicy.notificationsVisible(true, true, 4, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_LOW, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(false, true, ListenerPolicy.IMPORTANCE_DEFAULT, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, false, ListenerPolicy.IMPORTANCE_DEFAULT, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_NONE, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_MIN, false, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_DEFAULT, true, true));
    assertFalse(ListenerPolicy.notificationsVisible(true, true, ListenerPolicy.IMPORTANCE_DEFAULT, false, false));
    assertTrue(ListenerPolicy.INDICATOR_RECHECK_MS > 0 && ListenerPolicy.INDICATOR_RECHECK_MS <= 30_000);
  }

  @Test public void consentNeedsBothTheMicrophoneAndTheNotification() {
    assertTrue(ListenerPolicy.consentPermissionsGranted(true, true));
    assertFalse(ListenerPolicy.consentPermissionsGranted(true, false));
    assertFalse(ListenerPolicy.consentPermissionsGranted(false, true));
  }

  @Test public void ringingAndCallsPauseAndOnlyShortSystemSoundsLeaveWakeDetectionOn() {
    for (int mode : new int[] {0, -1, -2, 7}) assertFalse("mode " + mode, ListenerPolicy.callMode(mode));
    for (int mode = 1; mode <= 6; mode++) assertTrue("mode " + mode, ListenerPolicy.callMode(mode));
    for (int usage : new int[] {0, 1, 2, 3, 11, 12, 14, 16, 99}) assertTrue("usage " + usage, ListenerPolicy.playbackSuppressesWake(usage));
    for (int usage : new int[] {4, 5, 6, 7, 8, 9, 10, 13}) assertFalse("usage " + usage, ListenerPolicy.playbackSuppressesWake(usage));
  }

  @Test public void everyStateHasALockScreenSafeLabelAndAnOpenMicrophoneCanBePaused() {
    for (ListenerPolicy.State state : ListenerPolicy.State.values()) {
      assertFalse(state.name(), ListenerPolicy.foreground(state) && ListenerPolicy.needsAttention(state));
      assertEquals(state.name(), ListenerPolicy.foreground(state) && state != ListenerPolicy.State.PAUSED_USER, ListenerPolicy.pausable(state));
      if (ListenerPolicy.holdsMicrophone(state)) assertTrue(state.name(), ListenerPolicy.pausable(state));
      String label = ListenerPolicy.label(state);
      assertTrue(state.name(), !label.isEmpty() && label.length() < 64);
    }
  }

  @Test public void pausesEndOnTheMonotonicClockAndATimedPauseFromAnotherBootLastsUntilResumed() {
    assertEquals(ListenerPolicy.PAUSE_UNTIL_RESUMED, ListenerPolicy.pauseUntil(NOW, 0));
    assertEquals(NOW + 15 * 60_000L, ListenerPolicy.pauseUntil(NOW, 15));
    assertEquals(ListenerPolicy.PAUSE_UNTIL_RESUMED, ListenerPolicy.pauseUntil(Long.MAX_VALUE - 1, 60));
    assertEquals(0, ListenerPolicy.effectivePause(0, 7, 7));
    assertEquals(ListenerPolicy.PAUSE_UNTIL_RESUMED, ListenerPolicy.effectivePause(ListenerPolicy.PAUSE_UNTIL_RESUMED, 7, 8));
    assertEquals(NOW, ListenerPolicy.effectivePause(NOW, 7, 7));
    assertEquals(ListenerPolicy.PAUSE_UNTIL_RESUMED, ListenerPolicy.effectivePause(NOW, 7, 8));
    assertEquals(ListenerPolicy.PAUSE_UNTIL_RESUMED, ListenerPolicy.effectivePause(NOW, -1, 7));
  }

  @Test public void theStoredExitHistoryIsBoundedAndNeverTrustedToBeWellFormed() {
    long[] exits = new long[0];
    for (int i = 0; i < CrashLoopBreaker.LIMIT; i++) exits = CrashLoopBreaker.onProcessStart(exits, true, NOW + i * 1000);
    assertEquals(exits.length, CrashLoopBreaker.decode(CrashLoopBreaker.encode(exits)).length);
    assertEquals(1, CrashLoopBreaker.decode("x,-4,,12").length);
    assertEquals(0, CrashLoopBreaker.decode(null).length);
    assertEquals(0, CrashLoopBreaker.prune(null, NOW).length);
    long[] many = new long[0];
    for (int i = 0; i < 40; i++) many = CrashLoopBreaker.onProcessStart(many, true, NOW + i);
    assertEquals(CrashLoopBreaker.KEEP, many.length);
  }

  @Test public void onlyASessionLeftOpenInThisBootByThisInstallIsACrash() {
    assertFalse(CrashLoopBreaker.uncleanExit(false, 7, 7, 100, 100));
    assertTrue(CrashLoopBreaker.uncleanExit(true, 7, 7, 100, 100));
    assertFalse(CrashLoopBreaker.uncleanExit(true, 7, 8, 100, 100));
    assertFalse(CrashLoopBreaker.uncleanExit(true, 7, 7, 100, 200));
    assertTrue(CrashLoopBreaker.uncleanExit(true, -1, 8, 100, 100));
    assertTrue(CrashLoopBreaker.uncleanExit(true, 7, -1, 100, 100));
    long[] reboots = new long[0];
    for (int i = 0; i < 5; i++) reboots = CrashLoopBreaker.onProcessStart(reboots, CrashLoopBreaker.uncleanExit(true, i, i + 1, 100, 100), NOW + i * 1000);
    assertFalse(CrashLoopBreaker.tripped(reboots, NOW + 5000));
  }
}

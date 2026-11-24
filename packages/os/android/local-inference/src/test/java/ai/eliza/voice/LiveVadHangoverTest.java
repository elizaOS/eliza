// spec/os/voice/liveCapture.md, "Only a speech segment and its short pre-roll leave the capture, and nothing is stored"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class LiveVadHangoverTest {
  @Test public void aCaptureAsksForItsStartRunHangoverAndBargeInRunInWholeClampedWindows() {
    LiveCaptureOptions plain = LiveCaptureOptions.of(true);
    assertEquals(LiveVadGate.START_WINDOWS, plain.startWindows);
    assertEquals(LiveVadGate.END_WINDOWS, plain.endWindows);
    assertFalse(plain.bargeIn);
    LiveCaptureOptions quick = LiveCaptureOptions.of(true, null, 160, true, null);
    assertEquals(5, quick.endWindows);
    assertEquals(160, quick.endHangoverMs());
    assertEquals(2, quick.startWindows);
    assertTrue(quick.bargeIn);
    assertEquals(9, quick.bargeInWindows);
    assertEquals(288, quick.bargeInMs());
    assertEquals(5, LiveCaptureOptions.of(false, null, 170, false, null).endWindows);
    assertEquals(6, LiveCaptureOptions.of(false, null, 180, false, null).endWindows);
    assertEquals(96, LiveCaptureOptions.of(false, 1, 10, false, 1).endHangoverMs());
    assertEquals(1024, LiveCaptureOptions.of(false, 9000, 9000, false, 9000).endHangoverMs());
    assertEquals(1, LiveCaptureOptions.of(false, 1, null, false, null).startWindows);
    assertEquals(8, LiveCaptureOptions.of(false, 9000, null, false, null).startWindows);
    assertEquals(2, LiveCaptureOptions.of(false, null, null, true, 1).bargeInWindows);
  }

  @Test public void aShortHangoverClosesTheSegmentAfterItsQuietWindowsAndASpeechWindowRestartsIt() {
    LiveCaptureOptions quick = LiveCaptureOptions.of(true, null, 160, true, null);
    LiveVadGate gate = new LiveVadGate(quick.startWindows, quick.endWindows);
    assertEquals(LiveVadGate.Edge.NONE, gate.accept(0.9f));
    assertEquals(LiveVadGate.Edge.SPEECH_START, gate.accept(0.9f));
    for (int i = 0; i < 4; i++) assertEquals(LiveVadGate.Edge.NONE, gate.accept(0.1f));
    assertEquals(LiveVadGate.Edge.NONE, gate.accept(0.4f));
    for (int i = 0; i < 4; i++) assertEquals(LiveVadGate.Edge.NONE, gate.accept(0.1f));
    assertEquals(LiveVadGate.Edge.SPEECH_END, gate.accept(0.1f));
    assertFalse(gate.speaking());
    LiveVadGate slow = new LiveVadGate(4, 3);
    for (int i = 0; i < 3; i++) assertEquals(LiveVadGate.Edge.NONE, slow.accept(0.8f));
    assertEquals(LiveVadGate.Edge.SPEECH_START, slow.accept(0.8f));
  }

  @Test public void theBargeInRunCountsSpeechWindowsAndAWindowBelowTheStartThresholdRestartsIt() {
    LiveVadGate run = new LiveVadGate();
    for (int i = 1; i <= 9; i++) {
      run.accept(0.7f);
      assertEquals(i, run.speechRun());
    }
    run.accept(0.4f);
    assertEquals(0, run.speechRun());
    assertTrue(run.speaking());
    run.accept(0.6f);
    assertEquals(1, run.speechRun());
    run.close();
    assertEquals(0, run.speechRun());
  }
}

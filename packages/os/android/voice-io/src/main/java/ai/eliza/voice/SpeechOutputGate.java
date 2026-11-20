// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"; spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
package ai.eliza.voice;

import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

public final class SpeechOutputGate {
  public enum Notice { REFUSED_CALL_ACTIVE, REFUSED_FOCUS_DENIED, STOP_PLAYBACK, ABANDON_FOCUS, DUCK_VOLUME, RESTORE_VOLUME, STOP_CAPTURE }

  private final SpeechAudioFocusPolicy focus = new SpeechAudioFocusPolicy();
  private SpeechAudioFocusPolicy.Mode mode = SpeechAudioFocusPolicy.Mode.NORMAL;
  private SpeechOutputWarmup warmup;

  public synchronized boolean speaking() {
    return focus.held();
  }

  public synchronized boolean ducked() {
    return focus.ducked();
  }

  public synchronized boolean callActive() {
    return SpeechAudioFocusPolicy.callActive(mode);
  }

  public synchronized SpeechOutputWarmup warmup() {
    return warmup;
  }

  public synchronized boolean requestWarmup(Supplier<SpeechOutputWarmup> start) {
    if (focus.held() || callActive()) return false;
    retireWarmup();
    warmup = start.get();
    return true;
  }

  public synchronized boolean stopWarmup() {
    if (warmup == null) return false;
    retireWarmup();
    return true;
  }

  public synchronized List<Notice> startSpeech(BooleanSupplier requestFocus) {
    if (focus.held()) return null;
    if (callActive()) return List.of(Notice.REFUSED_CALL_ACTIVE);
    if (!focus.granted(requestFocus.getAsBoolean())) return List.of(Notice.REFUSED_FOCUS_DENIED);
    retireWarmup();
    return List.of();
  }

  public synchronized List<Notice> modeChanged(SpeechAudioFocusPolicy.Mode next) {
    boolean call = SpeechAudioFocusPolicy.callActive(next);
    boolean changed = call != callActive();
    mode = next;
    if (!changed) return null;
    if (!call) return List.of();
    retireWarmup();
    if (!focus.held()) return List.of(Notice.STOP_CAPTURE);
    return focus.released()
        ? List.of(Notice.STOP_PLAYBACK, Notice.ABANDON_FOCUS, Notice.STOP_CAPTURE)
        : List.of(Notice.STOP_PLAYBACK, Notice.STOP_CAPTURE);
  }

  public synchronized List<Notice> focusChanged(SpeechAudioFocusPolicy.Event event) {
    if (!focus.held()) return null;
    switch (focus.changed(event)) {
      case STOP:
        return stopped();
      case DUCK:
        return List.of(Notice.DUCK_VOLUME);
      case RESTORE:
        return List.of(Notice.RESTORE_VOLUME);
      case NONE:
        return List.of();
      default:
        throw new IllegalStateException("Unknown focus action");
    }
  }

  public synchronized List<Notice> end() {
    if (!focus.held()) return null;
    return focus.released() ? List.of(Notice.ABANDON_FOCUS) : List.of();
  }

  public synchronized List<Notice> cancel() {
    if (!focus.held()) return null;
    return stopped();
  }

  private List<Notice> stopped() {
    return focus.released() ? List.of(Notice.STOP_PLAYBACK, Notice.ABANDON_FOCUS) : List.of(Notice.STOP_PLAYBACK);
  }

  private void retireWarmup() {
    SpeechOutputWarmup retired = warmup;
    warmup = null;
    if (retired != null) retired.close();
  }
}

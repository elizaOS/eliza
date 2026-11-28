// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"; spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "A listener holds focus while its microphone is open, and a transient loss pauses it until focus returns"
package ai.eliza.voice;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

public final class SpeechOutputGate {
  public enum Notice {
    REFUSED_CALL_ACTIVE, REFUSED_FOCUS_DENIED, REFUSED_FOCUS_PAUSED, STOP_PLAYBACK, ABANDON_FOCUS, DUCK_VOLUME, RESTORE_VOLUME, STOP_CAPTURE,
    PAUSE_LISTENING, RESUME_LISTENING, PERMANENT_LOSS
  }

  private final SpeechAudioFocusPolicy focus = new SpeechAudioFocusPolicy();
  private SpeechAudioFocusPolicy.Mode mode = SpeechAudioFocusPolicy.Mode.NORMAL;
  private SpeechOutputWarmup warmup;
  private boolean speaking, listening;

  public synchronized boolean speaking() {
    return speaking;
  }

  public synchronized boolean listening() {
    return listening;
  }

  public synchronized boolean paused() {
    return focus.paused();
  }

  public synchronized boolean ducked() {
    return focus.ducked();
  }

  synchronized void setDucked(boolean ducked) {
    focus.setDucked(ducked);
  }

  public synchronized boolean callActive() {
    return SpeechAudioFocusPolicy.callActive(mode);
  }

  public synchronized SpeechOutputWarmup warmup() {
    return warmup;
  }

  public synchronized boolean requestWarmup(Supplier<SpeechOutputWarmup> start) {
    if (speaking || callActive()) return false;
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
    if (speaking) return null;
    if (callActive()) return List.of(Notice.REFUSED_CALL_ACTIVE);
    if (focus.paused()) return List.of(Notice.REFUSED_FOCUS_PAUSED);
    if (!listening && !focus.granted(requestFocus.getAsBoolean())) return List.of(Notice.REFUSED_FOCUS_DENIED);
    speaking = true;
    retireWarmup();
    return List.of();
  }

  public synchronized List<Notice> openListening(BooleanSupplier requestFocus) {
    if (listening) return null;
    if (callActive()) return List.of(Notice.REFUSED_CALL_ACTIVE);
    if (!speaking && !focus.granted(requestFocus.getAsBoolean())) return List.of(Notice.REFUSED_FOCUS_DENIED);
    listening = true;
    return List.of();
  }

  public synchronized List<Notice> closeListening() {
    if (!listening) return null;
    listening = false;
    return speaking ? List.of() : abandoned();
  }

  public synchronized List<Notice> modeChanged(SpeechAudioFocusPolicy.Mode next) {
    boolean call = SpeechAudioFocusPolicy.callActive(next);
    boolean changed = call != callActive();
    mode = next;
    if (!changed) return null;
    if (!call) return List.of();
    retireWarmup();
    List<Notice> out = new ArrayList<>();
    if (speaking) out.add(Notice.STOP_PLAYBACK);
    boolean held = speaking || listening;
    speaking = false;
    listening = false;
    if (held) out.addAll(abandoned());
    out.add(Notice.STOP_CAPTURE);
    return out;
  }

  public synchronized List<Notice> focusChanged(SpeechAudioFocusPolicy.Event event) {
    if (!speaking && !listening) return null;
    boolean stopped = speaking;
    switch (focus.changed(event, listening)) {
      case STOP: {
        speaking = false;
        listening = false;
        List<Notice> out = new ArrayList<>();
        if (stopped) out.add(Notice.STOP_PLAYBACK);
        out.addAll(abandoned());
        if (event == SpeechAudioFocusPolicy.Event.LOSS) out.add(Notice.PERMANENT_LOSS);
        return out;
      }
      case PAUSE:
        speaking = false;
        return stopped ? List.of(Notice.STOP_PLAYBACK, Notice.PAUSE_LISTENING) : List.of(Notice.PAUSE_LISTENING);
      case RESUME:
        return List.of(Notice.RESUME_LISTENING);
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
    if (!speaking) return null;
    speaking = false;
    return listening ? List.of() : abandoned();
  }

  public synchronized List<Notice> cancel() {
    if (!speaking) return null;
    speaking = false;
    if (listening) return List.of(Notice.STOP_PLAYBACK);
    List<Notice> out = new ArrayList<>();
    out.add(Notice.STOP_PLAYBACK);
    out.addAll(abandoned());
    return out;
  }

  private List<Notice> abandoned() {
    return focus.released() ? List.of(Notice.ABANDON_FOCUS) : List.of();
  }

  private void retireWarmup() {
    SpeechOutputWarmup retired = warmup;
    warmup = null;
    if (retired != null) retired.close();
  }
}

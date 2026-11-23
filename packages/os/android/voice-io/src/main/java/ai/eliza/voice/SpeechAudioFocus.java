// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "A listener holds focus while its microphone is open, and a transient loss pauses it until focus returns"
package ai.eliza.voice;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.function.Supplier;

public final class SpeechAudioFocus {
  public interface Changes { void apply(List<SpeechOutputGate.Notice> notices); }

  public static final AudioAttributes ATTRIBUTES = new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ASSISTANT)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build();

  private final AudioManager audio;
  private final SpeechOutputGate gate;
  private final Changes changes;
  private final AudioFocusRequest request;
  private AudioManager.OnModeChangedListener modeListener;

  public SpeechAudioFocus(Context context, Handler main, SpeechOutputGate gate, Changes changes) {
    this.audio = context.getSystemService(AudioManager.class);
    this.gate = gate;
    this.changes = changes;
    this.request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(ATTRIBUTES)
        .setAcceptsDelayedFocusGain(false)
        .setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener(this::focusChanged, main)
        .build();
  }

  public static SpeechAudioFocusPolicy.Event event(int change) {
    switch (change) {
      case AudioManager.AUDIOFOCUS_GAIN: return SpeechAudioFocusPolicy.Event.GAIN;
      case AudioManager.AUDIOFOCUS_LOSS: return SpeechAudioFocusPolicy.Event.LOSS;
      case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: return SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT;
      case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: return SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT_CAN_DUCK;
      default: return null;
    }
  }

  public static SpeechAudioFocusPolicy.Mode mode(int mode) {
    switch (mode) {
      case AudioManager.MODE_NORMAL: return SpeechAudioFocusPolicy.Mode.NORMAL;
      case AudioManager.MODE_RINGTONE: return SpeechAudioFocusPolicy.Mode.RINGTONE;
      case AudioManager.MODE_IN_CALL: return SpeechAudioFocusPolicy.Mode.IN_CALL;
      case AudioManager.MODE_IN_COMMUNICATION: return SpeechAudioFocusPolicy.Mode.IN_COMMUNICATION;
      case AudioManager.MODE_CALL_SCREENING: return SpeechAudioFocusPolicy.Mode.CALL_SCREENING;
      case AudioManager.MODE_CALL_REDIRECT: return SpeechAudioFocusPolicy.Mode.CALL_REDIRECT;
      case AudioManager.MODE_COMMUNICATION_REDIRECT: return SpeechAudioFocusPolicy.Mode.COMMUNICATION_REDIRECT;
      default: return SpeechAudioFocusPolicy.Mode.OTHER;
    }
  }

  public SpeechAudioFocusPolicy.Mode mode() {
    return audio == null ? SpeechAudioFocusPolicy.Mode.OTHER : mode(audio.getMode());
  }

  public boolean callActive() {
    syncMode();
    return gate.callActive();
  }

  public boolean requestWarmup(Supplier<SpeechOutputWarmup> start) {
    syncMode();
    return gate.requestWarmup(start);
  }

  public void stopWarmup() {
    gate.stopWarmup();
  }

  public String startSpeech() {
    syncMode();
    return refusal(gate.startSpeech(this::requestFocus));
  }

  public String openListening() {
    syncMode();
    return refusal(gate.openListening(this::requestFocus));
  }

  public void closeListening() {
    apply(gate.closeListening());
  }

  private boolean requestFocus() {
    return audio != null && audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
  }

  private static String refusal(List<SpeechOutputGate.Notice> notices) {
    if (notices == null || notices.isEmpty()) return null;
    if (notices.contains(SpeechOutputGate.Notice.REFUSED_CALL_ACTIVE)) return SpeechAudioFocusPolicy.CALL_ACTIVE;
    return notices.contains(SpeechOutputGate.Notice.REFUSED_FOCUS_PAUSED) ? SpeechAudioFocusPolicy.FOCUS_PAUSED : SpeechAudioFocusPolicy.FOCUS_DENIED;
  }

  public void endSpeech() {
    apply(gate.end());
  }

  public void cancelSpeech() {
    apply(gate.cancel());
  }

  public void watchCalls(Executor executor) {
    if (audio == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S || modeListener != null) return;
    modeListener = next -> apply(gate.modeChanged(mode(next)));
    audio.addOnModeChangedListener(executor, modeListener);
  }

  public void close() {
    cancelSpeech();
    closeListening();
    gate.stopWarmup();
    if (modeListener != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.removeOnModeChangedListener(modeListener);
    modeListener = null;
  }

  private void focusChanged(int change) {
    SpeechAudioFocusPolicy.Event event = event(change);
    if (event == null) return;
    boolean loss = event == SpeechAudioFocusPolicy.Event.LOSS || event == SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT;
    SpeechAudioFocusPolicy.Mode current = mode();
    apply(loss && SpeechAudioFocusPolicy.callActive(current) ? gate.modeChanged(current) : gate.focusChanged(event));
  }

  private void syncMode() {
    apply(gate.modeChanged(mode()));
  }

  private void apply(List<SpeechOutputGate.Notice> notices) {
    if (notices == null || notices.isEmpty()) return;
    if (notices.contains(SpeechOutputGate.Notice.ABANDON_FOCUS) && audio != null) audio.abandonAudioFocusRequest(request);
    changes.apply(notices);
  }
}

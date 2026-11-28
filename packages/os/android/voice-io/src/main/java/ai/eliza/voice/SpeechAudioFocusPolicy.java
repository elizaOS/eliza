// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "A listener holds focus while its microphone is open, and a transient loss pauses it until focus returns"
package ai.eliza.voice;

public final class SpeechAudioFocusPolicy {
  public enum Event { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }

  public enum Action { NONE, STOP, DUCK, RESTORE, PAUSE, RESUME }

  public enum Mode { NORMAL, RINGTONE, IN_CALL, IN_COMMUNICATION, CALL_SCREENING, CALL_REDIRECT, COMMUNICATION_REDIRECT, OTHER }

  public static final float DUCK_VOLUME = 0.2f;
  public static final String CALL_ACTIVE = "call-active";
  public static final String FOCUS_DENIED = "audio-focus-denied";
  public static final String FOCUS_PAUSED = "audio-focus-paused";

  private enum State { IDLE, HELD, DUCKED, PAUSED }

  private State state = State.IDLE;
  private boolean requested;

  public static boolean callActive(Mode mode) {
    return mode != Mode.NORMAL && mode != Mode.OTHER;
  }

  public static String admission(Mode mode) {
    return callActive(mode) ? CALL_ACTIVE : null;
  }

  public synchronized boolean granted(boolean granted) {
    state = granted ? State.HELD : State.IDLE;
    requested |= granted;
    return granted;
  }

  public synchronized boolean held() {
    return state != State.IDLE;
  }

  public synchronized boolean ducked() {
    return state == State.DUCKED;
  }

  synchronized void setDucked(boolean ducked) {
    if (state == State.HELD || state == State.DUCKED) state = ducked ? State.DUCKED : State.HELD;
  }

  public synchronized boolean paused() {
    return state == State.PAUSED;
  }

  public synchronized boolean released() {
    boolean abandon = requested;
    state = State.IDLE;
    requested = false;
    return abandon;
  }

  public synchronized Action changed(Event event, boolean listening) {
    if (state == State.IDLE) return Action.NONE;
    switch (event) {
      case LOSS:
        state = State.IDLE;
        return Action.STOP;
      case LOSS_TRANSIENT:
        if (state == State.PAUSED) return Action.NONE;
        state = listening ? State.PAUSED : State.IDLE;
        return listening ? Action.PAUSE : Action.STOP;
      case LOSS_TRANSIENT_CAN_DUCK:
        if (state == State.PAUSED) {
          state = State.DUCKED;
          return Action.RESUME;
        }
        if (state == State.DUCKED) return Action.NONE;
        state = State.DUCKED;
        return Action.DUCK;
      case GAIN:
        if (state == State.PAUSED) {
          state = State.HELD;
          return Action.RESUME;
        }
        if (state != State.DUCKED) return Action.NONE;
        state = State.HELD;
        return Action.RESTORE;
      default:
        throw new IllegalArgumentException("Unknown focus change " + event);
    }
  }
}

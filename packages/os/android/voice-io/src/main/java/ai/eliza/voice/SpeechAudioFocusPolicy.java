// spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"
package ai.eliza.voice;

public final class SpeechAudioFocusPolicy {
  public enum Event { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }

  public enum Action { NONE, STOP, DUCK, RESTORE }

  public enum Mode { NORMAL, RINGTONE, IN_CALL, IN_COMMUNICATION, CALL_SCREENING, CALL_REDIRECT, COMMUNICATION_REDIRECT, OTHER }

  public static final float DUCK_VOLUME = 0.2f;
  public static final String CALL_ACTIVE = "call-active";
  public static final String FOCUS_DENIED = "audio-focus-denied";

  private enum State { IDLE, HELD, DUCKED }

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

  public synchronized boolean released() {
    boolean abandon = requested;
    state = State.IDLE;
    requested = false;
    return abandon;
  }

  public synchronized Action changed(Event event) {
    if (state == State.IDLE) return Action.NONE;
    switch (event) {
      case LOSS:
      case LOSS_TRANSIENT:
        state = State.IDLE;
        return Action.STOP;
      case LOSS_TRANSIENT_CAN_DUCK:
        if (state == State.DUCKED) return Action.NONE;
        state = State.DUCKED;
        return Action.DUCK;
      case GAIN:
        if (state != State.DUCKED) return Action.NONE;
        state = State.HELD;
        return Action.RESTORE;
      default:
        throw new IllegalArgumentException("Unknown focus change " + event);
    }
  }
}

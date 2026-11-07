package ai.eliza.voice;

/**
 * Audio focus and call-state policy for assistant speech. Pure state; the Android
 * glue ({@link SpeechAudioFocus}) maps AudioManager constants onto these events and applies
 * the returned actions.
 *
 * <ul>
 * <li>Speech requests transient focus that lets other audio duck (assistant usage, speech content)
 *     only while it plays, and abandons it when the utterance ends or is stopped.</li>
 * <li>No speech starts while the phone is ringing or in a call (telephony or VoIP mode): the
 *     caller reports {@link #CALL_ACTIVE} instead of playing over the call.</li>
 * <li>Permanent or transient loss stops the utterance and clears its unplayed audio; a ducking
 *     loss lowers the volume and a regain restores it. A loss caused by a call also stops the
 *     voice assistant's microphone capture.</li>
 * </ul>
 */
public final class SpeechAudioFocusPolicy {
 public enum Event { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }
 public enum Action { NONE, STOP, DUCK, RESTORE }
 public enum Mode { NORMAL, RINGTONE, IN_CALL, IN_COMMUNICATION, CALL_SCREENING, CALL_REDIRECT, COMMUNICATION_REDIRECT, OTHER }
 public static final float DUCK_VOLUME=0.2f;
 public static final String CALL_ACTIVE="call-active",FOCUS_DENIED="audio-focus-denied";
 private enum State { IDLE, HELD, DUCKED }
 private State state=State.IDLE;

 /** Ringing, a telephony call, VoIP/communication or call screening/redirection holds the audio path. */
 public static boolean callActive(Mode mode){return mode!=Mode.NORMAL&&mode!=Mode.OTHER;}
 /**
  * Whether speech may start now: null when it may (and focus must then be requested), or the
  * refusal code. Refuses during a call without asking for focus.
  */
 public static String admission(Mode mode){return callActive(mode)?CALL_ACTIVE:null;}

 /** The platform answered the focus request. */
 public synchronized boolean granted(boolean granted){state=granted?State.HELD:State.IDLE;return granted;}
 public synchronized boolean held(){return state!=State.IDLE;}
 /** Speech ended or was stopped: focus is abandoned. */
 public synchronized void released(){state=State.IDLE;}
 /** A focus change while speech holds focus. */
 public synchronized Action changed(Event event){
  if(state==State.IDLE)return Action.NONE;
  switch(event){
   case LOSS:case LOSS_TRANSIENT:state=State.IDLE;return Action.STOP;
   case LOSS_TRANSIENT_CAN_DUCK:if(state==State.DUCKED)return Action.NONE;state=State.DUCKED;return Action.DUCK;
   case GAIN:if(state!=State.DUCKED)return Action.NONE;state=State.HELD;return Action.RESTORE;
   default:return Action.NONE;
  }
 }
 /** A stop caused by focus loss while a call is active also stops assistant capture. */
 public static boolean stopsCapture(Action action,Mode mode){return action==Action.STOP&&callActive(mode);}
}

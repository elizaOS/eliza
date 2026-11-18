package ai.eliza.voice;

/**
 * Audio focus and call-state policy for assistant speech. Pure state; the Android
 * glue ({@link SpeechAudioFocus}) maps AudioManager constants onto these events and applies
 * the returned actions.
 *
 * <ul>
 * <li>Speech requests transient focus that lets other audio duck (assistant usage, speech content)
 *     while its owner needs it (while it speaks; the cloud bridge also while it listens), and
 *     abandons it afterwards.</li>
 * <li>No speech starts while the phone is ringing or in a call (telephony or VoIP mode): the
 *     caller reports {@link #CALL_ACTIVE} instead of playing over the call.</li>
 * <li>Permanent or transient loss stops the utterance and clears its unplayed audio; a ducking
 *     loss lowers the volume and a regain restores it. A loss caused by a call also stops the
 *     voice assistant's microphone capture.</li>
 * <li>An owner that also listens (the cloud bridge) can ask for {@link Action#PAUSE} on a transient
 *     loss instead: it stops the utterance and pauses listening, keeps its request on the focus
 *     stack, and gets {@link Action#RESUME} on the regain. Only a permanent loss stops it.</li>
 * </ul>
 */
public final class SpeechAudioFocusPolicy {
 public enum Event { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }
 public enum Action { NONE, STOP, DUCK, RESTORE, PAUSE, RESUME }
 public enum Mode { NORMAL, RINGTONE, IN_CALL, IN_COMMUNICATION, CALL_SCREENING, CALL_REDIRECT, COMMUNICATION_REDIRECT, OTHER }
 public static final float DUCK_VOLUME=0.2f;
 public static final String CALL_ACTIVE="call-active",FOCUS_DENIED="audio-focus-denied";
 private enum State { IDLE, HELD, DUCKED, PAUSED }
 private State state=State.IDLE;
 private final boolean pauseOnTransientLoss;
 // A granted request stays on the platform focus stack after a transient loss until it is abandoned.
 private boolean requested;

 /** A transient loss stops the owner, as a permanent one does. */
 public SpeechAudioFocusPolicy(){this(false);}
 /** With {@code pauseOnTransientLoss}, a transient loss pauses the owner and the regain resumes it. */
 public SpeechAudioFocusPolicy(boolean pauseOnTransientLoss){this.pauseOnTransientLoss=pauseOnTransientLoss;}

 /** Ringing, a telephony call, VoIP/communication or call screening/redirection holds the audio path. */
 public static boolean callActive(Mode mode){return mode!=Mode.NORMAL&&mode!=Mode.OTHER;}
 /**
  * Whether speech may start now: null when it may (and focus must then be requested), or the
  * refusal code. Refuses during a call without asking for focus.
  */
 public static String admission(Mode mode){return callActive(mode)?CALL_ACTIVE:null;}

 /** The platform answered the focus request. */
 public synchronized boolean granted(boolean granted){state=granted?State.HELD:State.IDLE;requested|=granted;return granted;}
 public synchronized boolean held(){return state!=State.IDLE;}
 public synchronized boolean ducked(){return state==State.DUCKED;}
 /** A transient loss paused the owner; nothing may play or listen until the regain. */
 public synchronized boolean paused(){return state==State.PAUSED;}
 /**
  * Speech ended or was stopped: true when a granted request must now be abandoned, including after
  * a loss (a transiently displaced request would otherwise get focus back with nothing playing).
  */
 public synchronized boolean released(){boolean abandon=requested;state=State.IDLE;requested=false;return abandon;}
 /** A focus change while speech holds focus. */
 public synchronized Action changed(Event event){
  if(state==State.IDLE)return Action.NONE;
  switch(event){
   case LOSS:state=State.IDLE;return Action.STOP;
   case LOSS_TRANSIENT:
    if(!pauseOnTransientLoss){state=State.IDLE;return Action.STOP;}
    if(state==State.PAUSED)return Action.NONE;state=State.PAUSED;return Action.PAUSE;
   // A ducking change after a pause hands focus back lowered: resume, and new speech starts ducked.
   case LOSS_TRANSIENT_CAN_DUCK:if(state==State.PAUSED){state=State.DUCKED;return Action.RESUME;}if(state==State.DUCKED)return Action.NONE;state=State.DUCKED;return Action.DUCK;
   case GAIN:if(state==State.PAUSED){state=State.HELD;return Action.RESUME;}if(state!=State.DUCKED)return Action.NONE;state=State.HELD;return Action.RESTORE;
   default:return Action.NONE;
  }
 }
 /** A stop caused by focus loss while a call is active also stops assistant capture. */
 public static boolean stopsCapture(Action action,Mode mode){return action==Action.STOP&&callActive(mode);}
}

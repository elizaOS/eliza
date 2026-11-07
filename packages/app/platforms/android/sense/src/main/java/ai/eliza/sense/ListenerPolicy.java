package ai.eliza.sense;

/**
 * The listener's single source of truth for whether the microphone may be open. Pure Java so the
 * rules run on the JVM in repository tests; the Android service feeds it observed inputs.
 *
 * Off is the default and every unknown or unavailable input resolves away from capture. Only
 * {@link State#LISTENING} processes audio. {@link State#PAUSED_MIC_UNAVAILABLE} keeps the silenced
 * recording open only so Android can report when the microphone is released again; its frames
 * are discarded unread.
 */
public final class ListenerPolicy {
 private ListenerPolicy(){}

 /** Bump when what is captured, where it goes or what is kept changes; older consent then lapses. */
 public static final int CONSENT_VERSION=1;
 /** User pause that lasts until the user resumes. */
 public static final long PAUSE_UNTIL_RESUMED=Long.MAX_VALUE;

 public enum State {
  /** No consent, consent withdrawn or the user turned listening off. Nothing runs. */
  OFF,
  /** Consent exists but RECORD_AUDIO was revoked; the user must grant it again in the listener settings. */
  PERMISSION_REQUIRED,
  /**
   * The listener's own indicator could not be shown (notification permission denied, the app's
   * notifications or the listening channel blocked, lowered to silent or minimised, or hidden from the lock screen).
   * Listening is never armed without its visible indicator.
   */
  NOTIFICATIONS_REQUIRED,
  /** Repeated unclean exits; capture stays stopped until the user turns it back on. */
  STOPPED_AFTER_ERRORS,
  /**
   * The SystemUI indicator lease was lost while the microphone was held (SystemUI died, its
   * Listening chip or surface was hidden, detached or not attributed, or the lease expired or was
   * revoked). Capture stopped and stays stopped until the user resumes; a returning lease never
   * resumes it.
   */
  STOPPED_INDICATOR_LOST,
  /**
   * The primary user (the only user the listener is installed for) is not the foreground user, so
   * its notification is invisible to whoever is using the phone. Never captures.
   */
  PAUSED_OTHER_USER,
  /** Booted and not yet unlocked (before first unlock). Never captures. */
  WAITING_FOR_UNLOCK,
  /** The local speech model could not be loaded. Never captures. */
  SPEECH_UNAVAILABLE,
  /**
   * No fresh SystemUI indicator lease (SystemUI has not yet acknowledged a visible Listening
   * surface). Never captures; capture starts once a lease is fresh.
   */
  INDICATOR_UNAVAILABLE,
  PAUSED_USER,
  PAUSED_CALL,
  /** Another app is recording; the listener releases the microphone until it finishes. */
  PAUSED_MIC_IN_USE,
  /** The listener's own recording is silenced (microphone privacy toggle or audio policy). */
  PAUSED_MIC_UNAVAILABLE,
  /**
   * Explained indicator pauses ({@link IndicatorPause}): SystemUI reports why the Listening
   * indicator is not shown. The microphone is released; capture resumes by itself only on a fresh
   * acknowledgement of a visible surface. Display off, or AOD not showing the indicator.
   */
  PAUSED_DISPLAY_OFF,
  /** An app hid the status bar (fullscreen/immersive) while the phone is unlocked. */
  PAUSED_FULLSCREEN,
  /** The notification shade is expanded and does not show the listening notification. */
  PAUSED_SHADE,
  /** Within SystemUI's debounce after a lock, unlock or screen-state change. */
  PAUSED_TRANSITION,
  LISTENING
 }

 /** Why SystemUI says the indicator is not shown, when it explains it. NONE: shown, or an unexplained loss. */
 public enum IndicatorPause{NONE,DISPLAY_OFF,FULLSCREEN,SHADE,TRANSITION}

 /** Observed inputs. Defaults are the most restrictive values. */
 public static final class Inputs {
  public int consentVersion;
  public boolean enabled;
  public boolean recordAudioGranted;
  /** See {@link #notificationsVisible}. */
  public boolean notificationsVisible;
  /** The user the listener runs as is the current foreground user. */
  public boolean userForeground;
  public boolean crashLoopTripped;
  public boolean userUnlocked;
  public boolean speechUnavailable;
  /**
   * User pause end on the monotonic clock ({@code SystemClock.elapsedRealtime}), already passed
   * through {@link #effectivePause}: wall-clock changes cannot end it early, and a timed pause
   * from an earlier boot lasts until the user resumes.
   */
  public long pausedUntilMs;
  public boolean inCall;
  public boolean otherAppRecording;
  public boolean micSilenced;
  /** A fresh SystemUI indicator lease permits capture ({@link IndicatorLease#permits}). */
  public boolean indicatorLeaseValid;
  /** The lease was lost while the microphone was held; cleared only by an explicit user resume or turn-on. */
  public boolean indicatorLost;
  /** An explained indicator pause reported by SystemUI (null counts as NONE). */
  public IndicatorPause indicatorPause=IndicatorPause.NONE;
 }

 public static boolean consented(int storedVersion){return storedVersion==CONSENT_VERSION;}

 public static State decide(Inputs in,long nowMs){
  if(in==null||!consented(in.consentVersion)||!in.enabled)return State.OFF;
  if(!in.recordAudioGranted)return State.PERMISSION_REQUIRED;
  if(!in.notificationsVisible)return State.NOTIFICATIONS_REQUIRED;
  if(in.crashLoopTripped)return State.STOPPED_AFTER_ERRORS;
  if(in.indicatorLost)return State.STOPPED_INDICATOR_LOST;
  if(!in.userForeground)return State.PAUSED_OTHER_USER;
  if(!in.userUnlocked)return State.WAITING_FOR_UNLOCK;
  if(in.speechUnavailable)return State.SPEECH_UNAVAILABLE;
  if(in.pausedUntilMs>nowMs)return State.PAUSED_USER;
  if(in.inCall)return State.PAUSED_CALL;
  if(in.otherAppRecording)return State.PAUSED_MIC_IN_USE;
  // Every state below holds the microphone: none may run without SystemUI's independent indicator.
  if(in.indicatorPause!=null)switch(in.indicatorPause){
   case DISPLAY_OFF:return State.PAUSED_DISPLAY_OFF;
   case FULLSCREEN:return State.PAUSED_FULLSCREEN;
   case SHADE:return State.PAUSED_SHADE;
   case TRANSITION:return State.PAUSED_TRANSITION;
   default:break;
  }
  if(!in.indicatorLeaseValid)return State.INDICATOR_UNAVAILABLE;
  if(in.micSilenced)return State.PAUSED_MIC_UNAVAILABLE;
  return State.LISTENING;
 }

 /** Audio frames are analysed only in this state. */
 public static boolean processesAudio(State state){return state==State.LISTENING;}

 /** An AudioRecord may be open (silenced recordings stay open to observe release). */
 public static boolean holdsMicrophone(State state){return state==State.LISTENING||state==State.PAUSED_MIC_UNAVAILABLE;}

 /**
  * The microphone foreground service and its ongoing, lock-screen-visible notification run in
  * these states, so the user always has the indicator plus Pause/Resume/Stop while armed.
  */
 public static boolean foreground(State state){
  switch(state){
   case LISTENING:case PAUSED_USER:case PAUSED_CALL:case PAUSED_MIC_IN_USE:case PAUSED_MIC_UNAVAILABLE:
   case PAUSED_DISPLAY_OFF:case PAUSED_FULLSCREEN:case PAUSED_SHADE:case PAUSED_TRANSITION:return true;
   default:return false;
  }
 }

 /** States the user should be told about although nothing is captured. */
 public static boolean needsAttention(State state){
  return state==State.PERMISSION_REQUIRED||state==State.NOTIFICATIONS_REQUIRED||state==State.STOPPED_AFTER_ERRORS||state==State.WAITING_FOR_UNLOCK||state==State.SPEECH_UNAVAILABLE
   ||state==State.INDICATOR_UNAVAILABLE||state==State.STOPPED_INDICATOR_LOST;
 }

 /** Lock-screen-safe status text. Never contains captured content. */
 public static String label(State state){
  switch(state){
   case LISTENING:return "Listening";
   case PAUSED_USER:return "Listening paused";
   case PAUSED_CALL:return "Paused during call";
   case PAUSED_MIC_IN_USE:return "Paused — another app is using the microphone";
   case PAUSED_MIC_UNAVAILABLE:return "Paused — microphone unavailable";
   case PAUSED_DISPLAY_OFF:return "Paused — screen off without Always-on display";
   case PAUSED_FULLSCREEN:return "Paused while an app is fullscreen";
   case PAUSED_SHADE:return "Paused while the notification shade is open";
   case PAUSED_TRANSITION:return "Paused while the screen changes";
   case WAITING_FOR_UNLOCK:return "Listening starts after unlock";
   case SPEECH_UNAVAILABLE:return "Listening unavailable — speech model not ready";
   case STOPPED_AFTER_ERRORS:return "Listening stopped after repeated errors";
   case STOPPED_INDICATOR_LOST:return "Listening stopped — indicator not shown";
   case INDICATOR_UNAVAILABLE:return "Listening waits for the system indicator";
   case PERMISSION_REQUIRED:return "Listening needs microphone permission";
   case NOTIFICATIONS_REQUIRED:return "Listening needs its notification";
   case PAUSED_OTHER_USER:return "Paused while another user is active";
   default:return "Listening off";
  }
 }

 /**
  * Losing the lease while the microphone is held latches {@link State#STOPPED_INDICATOR_LOST}: a
  * lease that later returns never restarts capture by itself. Losing it while nothing is captured
  * only withholds the next start ({@link State#INDICATOR_UNAVAILABLE}). An explained hidden
  * indicator (display off, AOD, fullscreen, shade, transition) is not a loss: it pauses.
  */
 public static boolean latchesIndicatorLoss(boolean microphoneHeld,boolean leaseValid,boolean explainedPause){return microphoneHeld&&!leaseValid&&!explainedPause;}

 /** The paused state for an explained indicator pause (true for every PAUSED_* indicator state). */
 public static boolean indicatorPaused(State state){
  return state==State.PAUSED_DISPLAY_OFF||state==State.PAUSED_FULLSCREEN||state==State.PAUSED_SHADE||state==State.PAUSED_TRANSITION;
 }

 /** Pausing reduces capability, so it never needs unlock. Resuming or turning on does. */
 public static boolean resumeRequiresUnlock(){return true;}

 /** Pause end for a duration in minutes; 0 or less pauses until the user resumes. */
 public static long pauseUntil(long nowMs,int minutes){
  if(minutes<=0)return PAUSE_UNTIL_RESUMED;
  long span=minutes*60_000L;
  return nowMs>Long.MAX_VALUE-span?PAUSE_UNTIL_RESUMED:nowMs+span;
 }

 /**
  * A stored pause as it applies now. Pause ends are on the monotonic clock, which restarts at boot,
  * so a timed pause recorded in another (or an unknown) boot cannot be compared: it is kept until
  * the user resumes rather than guessed to have ended.
  */
 public static long effectivePause(long storedUntil,long pauseBoot,long currentBoot){
  if(storedUntil<=0)return 0;
  if(storedUntil==PAUSE_UNTIL_RESUMED)return PAUSE_UNTIL_RESUMED;
  return pauseBoot>=0&&pauseBoot==currentBoot?storedUntil:PAUSE_UNTIL_RESUMED;
 }

 /** Android NotificationManager importance values (copied so this class stays Android-free). */
 public static final int IMPORTANCE_NONE=0,IMPORTANCE_MIN=1,IMPORTANCE_LOW=2,IMPORTANCE_DEFAULT=3;

 /**
  * Whether the listener's indicator notification can be seen in the shade and on the lock screen:
  * POST_NOTIFICATIONS granted, the app's notifications enabled, the listening channel at least
  * DEFAULT importance and not set to hide on the lock screen. A channel the user lowered to LOW is
  * a "silent" notification, which the lock screen hides when silent notifications are hidden, and
  * MIN is collapsed, so both count as not visible. The device-wide "show notifications on the lock
  * screen" setting being off (or unreadable) hides it as well. Anything else holds listening in
  * {@link State#NOTIFICATIONS_REQUIRED}.
  *
  * Android sends no broadcast when a channel is lowered or the lock-screen setting changes, so the
  * running service re-evaluates this at least every {@link #INDICATOR_RECHECK_MS} while it holds the
  * microphone and before each utterance is recognised.
  */
 public static boolean notificationsVisible(boolean postGranted,boolean appEnabled,int channelImportance,boolean channelHiddenOnLockScreen,boolean lockScreenShowsNotifications){
  return postGranted&&appEnabled&&channelImportance>=IMPORTANCE_DEFAULT&&!channelHiddenOnLockScreen&&lockScreenShowsNotifications;
 }

 /** Longest time the microphone stays open after the indicator silently stops being visible. */
 public static final long INDICATOR_RECHECK_MS=15_000;

 /** The consent screen records consent only when both the microphone and the indicator are allowed. */
 public static boolean consentPermissionsGranted(boolean recordAudio,boolean postNotifications){return recordAudio&&postNotifications;}

 /**
  * The wake phrase opens the host only while the phone is unlocked: an assistant surface started
  * behind the keyguard would appear unexpectedly at the next unlock. the spoken stop command
  * only reduces capability and is honoured while locked.
  */
 public static boolean mayInvokeAssistant(boolean keyguardLocked){return !keyguardLocked;}

 /**
  * Audio modes that pause listening: ringing, calls, call screening/redirect and VoIP. Raw
  * AudioManager.MODE_* values: RINGTONE 1, IN_CALL 2, IN_COMMUNICATION 3, CALL_SCREENING 4,
  * CALL_REDIRECT 5, COMMUNICATION_REDIRECT 6. NORMAL (0) and unknown values do not.
  */
 public static boolean callMode(int mode){return mode>=1&&mode<=6;}

 /**
  * Playback usages during which wake detection is suppressed, so speech from a speaker (the host's
  * own WebView voice plays as media, video, podcasts, navigation, calls, TTS) cannot invoke the
  * assistant. Only short non-speech system sounds do not suppress: alarm 4, notification 5,
  * ringtone 6, communication request 7, instant 8, delayed 9, event 10 and sonification 13
  * (raw AudioAttributes.USAGE_* values). Unknown usages suppress.
  */
 public static boolean playbackSuppressesWake(int usage){
  switch(usage){case 4:case 5:case 6:case 7:case 8:case 9:case 10:case 13:return false;default:return true;}
 }
}

package ai.eliza.sense;

/**
 * SystemUI indicator health lease (docs/aosp-listening-chip.md, ADR 0001). Pure Java so the rules
 * run on the JVM in repository tests; {@link IndicatorLeaseProvider} feeds it SystemUI's
 * acknowledgements and the service asks it whether capture may continue.
 *
 * The listener never trusts SystemUI's clock: every renewal is stamped with the listener's own
 * monotonic {@code SystemClock.elapsedRealtime}. A lease is generation-bound: acquiring starts a new
 * generation that is not fresh until SystemUI acknowledges a visible surface, an expired, revoked or
 * replaced generation can never be renewed again (SystemUI must acquire anew), and a lease from
 * another boot never counts.
 *
 * SystemUI also reports the default display state and, when the indicator is not shown, why.
 * An explained hidden indicator is a pause: display fully off or AOD not showing the chip
 * ({@link Loss#DISPLAY_OFF}), an app hiding the status bar ({@link Loss#FULLSCREEN}), the shade
 * expanded without the listening notification ({@link Loss#SHADE}), or a report within
 * SystemUI's debounce after a keyguard or screen-state change ({@link Loss#TRANSITION}). Capture
 * is released and resumes only on a fresh acknowledgement of a visible surface; explained
 * reports prove SystemUI is alive and extend the lease. Everything else is an unexplained loss
 * that stays stopped: expiry without a report, SystemUI death, revoke, a hidden surface or chip
 * without a reason, an unattributed recording, or an unknown display state while the listener
 * itself sees the screen on. The lease carries visibility facts only: no audio, transcript,
 * consent or resume command. It can only withhold capture; it never turns listening on.
 */
public final class IndicatorLease {
 /** Lease provider authority, method names and keys; mirrored by SystemUI's SenseListeningPolicy. */
 // The manifest derives the provider authority from the actual applicationId.
 public static final String ACQUIRE="acquire",RENEW="renew",REVOKE="revoke";
 public static final String KEY_TOKEN="token",KEY_GENERATION="generation",KEY_ACCEPTED="accepted",
  KEY_SURFACE="surfaceVisible",KEY_CHIP="chipVisible",KEY_RECORDING="recordingObserved",KEY_RENEW_MS="renewMs",KEY_DISPLAY="display";
 /** Default display as SystemUI reports it: on, dozing (AOD) or fully off. Anything else is unknown. */
 public static final String DISPLAY_ON="on",DISPLAY_DOZE="doze",DISPLAY_OFF="off";
 /** Why SystemUI does not show the indicator; mirrored by SenseListeningPolicy. Anything else is unexplained. */
 public static final String KEY_REASON="hiddenReason",REASON_NONE="none",REASON_DISPLAY_OFF="display_off",REASON_AOD="aod",
  REASON_FULLSCREEN="fullscreen",REASON_SHADE="shade",REASON_TRANSITION="transition";
 /** The only package admitted as the lease holder; it must also be platform-signed (see {@link #admitsController}). */
 public static final String SYSTEMUI_PACKAGE="com.android.systemui";
 /** SystemUI renews this often while a surface is visible. */
 public static final long RENEW_MS=1_000;
 /** A lease not renewed within this time expires; capture stops within TTL plus one main-thread dispatch. */
 public static final long TTL_MS=3_000;
 /** Time SystemUI has to observe and show a newly unsilenced recording before attribution is required. */
 public static final long ATTRIBUTION_GRACE_MS=2_500;

 /** Why the lease does not currently permit capture. {@link #NONE} means it does. */
 public enum Loss{NONE,NEVER_ACQUIRED,PENDING,EXPIRED,BINDER_DIED,REVOKED,REPLACED,OTHER_BOOT,SURFACE_HIDDEN,CHIP_HIDDEN,UNATTRIBUTED,
  /** Display state unknown or missing while the listener sees the screen on: unexplained. */
  UNKNOWN_STATE,
  /** Explained pauses: they end on a fresh acknowledgement of a visible surface. */
  DISPLAY_OFF,FULLSCREEN,SHADE,TRANSITION;
  public boolean pause(){return this==DISPLAY_OFF||this==FULLSCREEN||this==SHADE||this==TRANSITION;}
 }

 /** The policy's pause reason for a verdict (NONE for capture or for an unexplained loss). */
 public static ListenerPolicy.IndicatorPause pauseFor(Loss loss){
  switch(loss){
   case DISPLAY_OFF:return ListenerPolicy.IndicatorPause.DISPLAY_OFF;
   case FULLSCREEN:return ListenerPolicy.IndicatorPause.FULLSCREEN;
   case SHADE:return ListenerPolicy.IndicatorPause.SHADE;
   case TRANSITION:return ListenerPolicy.IndicatorPause.TRANSITION;
   default:return ListenerPolicy.IndicatorPause.NONE;
  }
 }

 /**
  * The phone sleeping during a display-off pause stops SystemUI's renewals (they run on its main
  * thread), so the lease lapses, and on wake SystemUI acquires a new generation that starts
  * pending. With the microphone already released by the pause, neither is a loss: capture still
  * waits for a fresh acknowledgement of a visible surface, but nothing latches.
  */
 public static boolean sleepLapse(boolean microphoneHeld,ListenerPolicy.IndicatorPause pause,Loss loss){
  return !microphoneHeld&&pause==ListenerPolicy.IndicatorPause.DISPLAY_OFF&&(loss==Loss.EXPIRED||loss==Loss.PENDING||loss==Loss.REPLACED);
 }

 private long generation;
 private boolean live;
 private boolean acknowledged;
 private long expiresAt;
 private long boot=Long.MIN_VALUE;
 private boolean surfaceVisible,chipVisible,recordingObserved;
 private String display=DISPLAY_ON,reason=REASON_NONE;
 private Loss lastLoss=Loss.NEVER_ACQUIRED;

 /** Starts a new generation. Any previous generation is replaced and can never be renewed. */
 public synchronized long acquire(long boot){
  if(live)lastLoss=Loss.REPLACED;
  generation++;
  live=true;acknowledged=false;this.boot=boot;
  surfaceVisible=chipVisible=recordingObserved=false;display=DISPLAY_ON;reason=REASON_NONE;
  return generation;
 }

 /**
  * A visibility acknowledgement for {@code gen}, stamped with the listener's clock {@code now}.
  * Refused (false) for a stale, revoked, expired, replaced or other-boot generation; SystemUI must
  * then acquire again. A refused or hidden acknowledgement never extends the lease.
  */
 public synchronized boolean renew(long gen,long now,long boot,boolean surface,boolean chip,boolean recording){
  return renew(gen,now,boot,surface,chip,recording,DISPLAY_ON,REASON_NONE);
 }

 public synchronized boolean renew(long gen,long now,long boot,boolean surface,boolean chip,boolean recording,String displayState){
  return renew(gen,now,boot,surface,chip,recording,displayState,REASON_NONE);
 }

 /** As above with SystemUI's display state and its reason ({@code REASON_*}) when the indicator is not shown. */
 public synchronized boolean renew(long gen,long now,long boot,boolean surface,boolean chip,boolean recording,String displayState,String hiddenReason){
  if(!live||gen!=generation)return false;
  if(boot!=this.boot){end(Loss.OTHER_BOOT);return false;}
  if(acknowledged&&now>=expiresAt){end(Loss.EXPIRED);return false;}
  surfaceVisible=surface;chipVisible=chip;recordingObserved=recording;
  display=DISPLAY_ON.equals(displayState)||DISPLAY_DOZE.equals(displayState)||DISPLAY_OFF.equals(displayState)?displayState:null;
  reason=hiddenReason==null?REASON_NONE:hiddenReason;
  // A visible surface, or a live SystemUI explaining why nothing is shown, keeps the lease alive.
  if(surface||display==null||explainedPause()!=null){acknowledged=true;expiresAt=now+TTL_MS;}
  return true;
 }

 /** Explicit revoke by SystemUI (surface detached, user switch, shutdown). Stale generations are ignored. */
 public synchronized void revoke(long gen){if(live&&gen==generation)end(Loss.REVOKED);}

 /** SystemUI's token binder died: its process is gone and nothing it showed can be trusted. */
 public synchronized void binderDied(long gen){if(live&&gen==generation)end(Loss.BINDER_DIED);}

 private void end(Loss why){live=false;acknowledged=false;lastLoss=why;surfaceVisible=chipVisible=recordingObserved=false;display=DISPLAY_ON;reason=REASON_NONE;}

 /**
  * The pause SystemUI's report explains, or null. Display off always explains itself; AOD not
  * showing the chip pauses like a dark display; with the display on only a recognised reason does.
  */
 private Loss explainedPause(){
  if(display==null)return null;
  if(DISPLAY_OFF.equals(display))return Loss.DISPLAY_OFF;
  if(DISPLAY_DOZE.equals(display))return Loss.DISPLAY_OFF;
  switch(reason){
   case REASON_FULLSCREEN:return Loss.FULLSCREEN;
   case REASON_SHADE:return Loss.SHADE;
   case REASON_TRANSITION:return Loss.TRANSITION;
   default:return null;
  }
 }

 /**
  * Whether capture may run now. {@code requireAttribution}: the listener has been capturing
  * unsilenced for longer than {@link #ATTRIBUTION_GRACE_MS}, so SystemUI must also report that it
  * observes the recording itself and shows the Listening chip.
  */
 public synchronized Loss verdict(long now,long boot,boolean requireAttribution){return verdict(now,boot,requireAttribution,true);}

 /**
  * {@code screenInteractive}: the listener's own view of the screen (PowerManager), used only to
  * resolve an unknown or missing display state: screen off is a pause, screen on an unexplained loss.
  */
 public synchronized Loss verdict(long now,long boot,boolean requireAttribution,boolean screenInteractive){
  if(!live)return lastLoss;
  if(boot!=this.boot){end(Loss.OTHER_BOOT);return lastLoss;}
  if(!acknowledged)return Loss.PENDING;
  if(now>=expiresAt){end(Loss.EXPIRED);return lastLoss;}
  if(display==null)return screenInteractive?Loss.UNKNOWN_STATE:Loss.DISPLAY_OFF;
  if(DISPLAY_OFF.equals(display))return Loss.DISPLAY_OFF;
  if(!surfaceVisible||recordingObserved&&!chipVisible){
   Loss pause=explainedPause();
   if(pause!=null)return pause;
   return surfaceVisible?Loss.CHIP_HIDDEN:Loss.SURFACE_HIDDEN;
  }
  if(requireAttribution&&!(recordingObserved&&chipVisible))return Loss.UNATTRIBUTED;
  return Loss.NONE;
 }

 public boolean permits(long now,long boot,boolean requireAttribution){return verdict(now,boot,requireAttribution)==Loss.NONE;}

 /** Delay until the service should re-check the lease while it holds the microphone. */
 public synchronized long nextCheckDelay(long now){
  long remaining=live&&acknowledged?expiresAt-now:0;
  return Math.max(50,Math.min(RENEW_MS,remaining));
 }

 synchronized long generation(){return live?generation:-1;}

 /** Attribution is required once unsilenced capture has run for longer than the grace period. */
 public static boolean requiresAttribution(boolean capturingUnsilenced,long unsilencedSince,long now){
  return capturingUnsilenced&&unsilencedSince>=0&&now-unsilencedSince>=ATTRIBUTION_GRACE_MS;
 }

 /**
  * The caller may hold the lease only when Android reports it holds STATUS_BAR_SERVICE (a
  * signature permission of the platform), its UID belongs to the system user and maps to exactly
  * the SystemUI package, and that package is signed with the platform certificate. The host, which
  * holds only LISTENER_CONTROL, can never renew a lease.
  */
 public static boolean admitsController(boolean holdsStatusBarService,int callingUid,String[] packagesForUid,boolean platformSigned){
  return holdsStatusBarService&&callingUid>=1000&&callingUid<100000&&packagesForUid!=null&&packagesForUid.length==1
   &&SYSTEMUI_PACKAGE.equals(packagesForUid[0])&&platformSigned;
 }
}

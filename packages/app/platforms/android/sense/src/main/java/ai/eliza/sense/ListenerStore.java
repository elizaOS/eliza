package ai.eliza.sense;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

/**
 * Listener settings in device-protected storage, so a persistent process started before first
 * unlock can read them and decide not to listen. Holds only flags and timestamps: never audio,
 * transcripts or account data. Consent is versioned; a missing or older version is no consent.
 */
// commit(), not apply(): consent, pause and the open-session marker must be durable before capture
// starts or stops, or a crash could lose a pause or hide an unclean exit.
@SuppressLint("ApplySharedPref")
final class ListenerStore {
 private static final String FILE=BuildConfig.SENSE_STORAGE_NAME;
 private static final String CONSENT="consentVersion",CONSENT_AT="consentAtMs",ENABLED="enabled",PAUSED_UNTIL="pausedUntilMs",
  SESSION_OPEN="captureSessionOpen",SESSION_BOOT="captureSessionBoot",SESSION_INSTALL="captureSessionInstall",
  PAUSE_BOOT="pauseBoot",EXITS="uncleanExits",TRIPPED="stoppedAfterErrors";
 private final SharedPreferences prefs;
 // Persisted consent cannot prove the last process saved a stop successfully. Each new
 // process requires explicit opt-in; a failed write stays latched off in this process.
 private static final Object CONSENT_LOCK=new Object();
 private static long resetGeneration;
 static void serializeConsent(Runnable action){synchronized(CONSENT_LOCK){action.run();}}
 static long consentGeneration(){synchronized(CONSENT_LOCK){return resetGeneration;}}
 private static volatile boolean processConsent;
 private static volatile boolean storageFailed;
 static boolean storageFailed(){ return storageFailed; }
 private boolean commit(SharedPreferences.Editor edit) {
  if (storageFailed) return false;
  boolean saved;
  try { saved = edit.commit(); } catch (RuntimeException failure) { saved = false; }
  if (!saved) {
   storageFailed = true; processConsent = false; Listener.epoch.invalidate();
   context.stopService(new android.content.Intent(context, ListeningService.class));
  }
  return saved;
 }

 private final Context context;

 ListenerStore(Context context){
  this.context=context;
  prefs=context.createDeviceProtectedStorageContext().getSharedPreferences(FILE,Context.MODE_PRIVATE);
 }

 /** Settings.Global.BOOT_COUNT, or -1 when it cannot be read. */
 static long bootCount(Context context){
  try{return Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT,-1);}catch(RuntimeException unavailable){return -1;}
 }

 /** This install's last update time, distinguishing a package update from a crash. */
 static long installStamp(Context context){
  try{return context.getPackageManager().getPackageInfo(context.getPackageName(),0).lastUpdateTime;}catch(PackageManager.NameNotFoundException|RuntimeException unavailable){return -1;}
 }

 int consentVersion(){return processConsent && !storageFailed ? prefs.getInt(CONSENT,0) : 0;}
 boolean enabled(){return processConsent && !storageFailed && prefs.getBoolean(ENABLED,false);}
 /** Stored pause end on the monotonic clock, kept until resumed when it came from another boot. */
 long pausedUntil(){return ListenerPolicy.effectivePause(prefs.getLong(PAUSED_UNTIL,0),prefs.getLong(PAUSE_BOOT,-1),bootCount(context));}
 long consentAt(){return prefs.getLong(CONSENT_AT,0);}

 /** Records the explicit opt-in shown in {@link ConsentActivity} and turns listening on. */
 boolean grantConsent(long now,long generation){
  synchronized(CONSENT_LOCK){
  if(generation!=resetGeneration)return false;
  processConsent = commit(prefs.edit().putInt(CONSENT,ListenerPolicy.CONSENT_VERSION).putLong(CONSENT_AT,now).putBoolean(ENABLED,true)
   .putLong(PAUSED_UNTIL,0).remove(EXITS).remove(TRIPPED));
  Listener.speechUnavailable=false;
  if(processConsent)Listener.indicatorLost=false;
  return processConsent;
  }
 }

 /** Withdraws consent: listening stops and must be opted into again. */
 void revokeConsent(){
  processConsent = false;
  commit(prefs.edit().remove(CONSENT).remove(CONSENT_AT).putBoolean(ENABLED,false).remove(PAUSED_UNTIL).remove(EXITS).remove(TRIPPED).putBoolean(SESSION_OPEN,false));
 }

 /** Delete only listener settings; the caller must observe a durable acknowledgement. */
 boolean reset(){
  synchronized(CONSENT_LOCK){
  resetGeneration++;
  processConsent=false;
  Listener.epoch.invalidate();
  // A reset can recover a previous failed write, but can never grant consent.
  boolean saved;
  try{saved=prefs.edit().clear().commit();}catch(RuntimeException failure){saved=false;}
  storageFailed=!saved;
  context.stopService(new android.content.Intent(context,ListeningService.class));
  return saved;
  }
 }

 /** Turning listening back on is an explicit user action and clears a tripped crash loop. */
 void setEnabled(boolean enabled){
  SharedPreferences.Editor edit=prefs.edit().putBoolean(ENABLED,enabled).putLong(PAUSED_UNTIL,0);
  // An explicit turn-on is the user action that clears a lost-indicator stop as well.
  if(enabled){edit.remove(EXITS).remove(TRIPPED);Listener.speechUnavailable=false;Listener.indicatorLost=false;}
  commit(edit);
 }

 /** {@code until} is {@link ListenerPolicy#PAUSE_UNTIL_RESUMED} or an {@code SystemClock.elapsedRealtime} deadline. */
 void pause(long until){commit(prefs.edit().putLong(PAUSED_UNTIL,until).putLong(PAUSE_BOOT,bootCount(context)));}
 void resume(){commit(prefs.edit().putLong(PAUSED_UNTIL,0).remove(EXITS).remove(TRIPPED));Listener.speechUnavailable=false;Listener.indicatorLost=false;}

 /** Marks a capture session open (true) or cleanly closed (false); a process start that finds it open counts an unclean exit. */
 boolean setSessionOpen(boolean open){
  return commit(prefs.edit().putBoolean(SESSION_OPEN,open).putLong(SESSION_BOOT,bootCount(context)).putLong(SESSION_INSTALL,installStamp(context)));
 }

 /**
  * Called once per process start. Android kills the process when RECORD_AUDIO is revoked, so a
  * start without the permission is not counted as a crash. Returns whether the breaker is tripped.
  */
 boolean recordProcessStart(long now,boolean countOpenSession){
  long[] exits=CrashLoopBreaker.onProcessStart(CrashLoopBreaker.decode(prefs.getString(EXITS,null)),countOpenSession&&CrashLoopBreaker.uncleanExit(prefs.getBoolean(SESSION_OPEN,false),
   prefs.getLong(SESSION_BOOT,-1),bootCount(context),prefs.getLong(SESSION_INSTALL,-1),installStamp(context)),now);
  boolean tripped=prefs.getBoolean(TRIPPED,false)||CrashLoopBreaker.tripped(exits,now);
  commit(prefs.edit().putString(EXITS,CrashLoopBreaker.encode(exits)).putBoolean(SESSION_OPEN,false).putBoolean(TRIPPED,tripped));
  return tripped;
 }

 /** Sticky once tripped: the window ageing out never restarts capture; only an explicit user action does. */
 boolean crashLoopTripped(){return prefs.getBoolean(TRIPPED,false);}
}

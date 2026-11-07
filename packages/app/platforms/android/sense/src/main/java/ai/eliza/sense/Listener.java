package ai.eliza.sense;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.os.UserManager;
import android.service.quicksettings.TileService;

/**
 * Process-wide listener coordination: gathers the policy inputs and starts or stops the
 * microphone service to match. Every control path (consent screen, notification, Quick Settings,
 * the host's control provider, unlock, process start) ends in {@link #refresh}.
 */
final class Listener {
 private Listener(){}
 static final String HOST_PACKAGE=BuildConfig.SENSE_HOST_PACKAGE;
 static final String CONTROL_PERMISSION=BuildConfig.APPLICATION_ID+".permission.LISTENER_CONTROL";

 // Observed by the running service; reset whenever capture stops so a stale value never blocks or admits capture.
 static volatile boolean inCall,otherAppRecording,micSilenced,speechUnavailable;

 static ListenerPolicy.Inputs inputs(Context context){
  ListenerStore store=new ListenerStore(context);
  ListenerPolicy.Inputs in=new ListenerPolicy.Inputs();
  in.consentVersion=store.consentVersion();
  in.enabled=store.enabled();
  in.recordAudioGranted=context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED;
  in.notificationsVisible=ListenerNotifications.indicatorVisible(context);
  in.crashLoopTripped=store.crashLoopTripped();
  UserManager users=context.getSystemService(UserManager.class);
  in.userUnlocked=users!=null&&users.isUserUnlocked();
  in.userForeground=userForeground(users);
  in.speechUnavailable=speechUnavailable;
  in.pausedUntilMs=store.pausedUntil();
  in.inCall=inCall;
  in.otherAppRecording=otherAppRecording;
  in.micSilenced=micSilenced;
  in.indicatorLeaseValid=observeIndicatorLease(context,SystemClock.elapsedRealtime());
  in.indicatorLost=indicatorLost;
  in.indicatorPause=indicatorPause;
  return in;
 }

 /** SystemUI's indicator health lease (fed by {@link IndicatorLeaseProvider}); in memory only, so it never outlives the process. */
 static final IndicatorLease lease=new IndicatorLease();
 /**
  * Set by the service while an AudioRecord is open, and the monotonic time capture last became
  * unsilenced (-1 while silenced or closed). Read here so every policy evaluation can latch a lost lease.
  */
 static volatile boolean microphoneHeld;
 static volatile long unsilencedSince=-1;
 /** Latched when the lease is lost while the microphone is held; only an explicit user resume or turn-on clears it. */
 static volatile boolean indicatorLost;
 /** The last lease verdict's explained pause (display off, AOD, fullscreen, shade, transition): never a latch. */
 static volatile ListenerPolicy.IndicatorPause indicatorPause=ListenerPolicy.IndicatorPause.NONE;
 /** The listener's own screen state (ACTION_SCREEN_ON/OFF, PowerManager); resolves an unknown display report. Unknown counts as on. */
 static volatile boolean screenInteractive=true;

 private static volatile long boot=Long.MIN_VALUE;
 /** The boot a lease belongs to, read once per process (the lease itself never outlives the process). */
 static long leaseBoot(Context context){
  long value=boot;
  if(value==Long.MIN_VALUE){value=ListenerStore.bootCount(context);boot=value;}
  return value;
 }

 /** Whether the lease permits capture now; latches {@link #indicatorLost} when it fails while capturing. */
 static boolean observeIndicatorLease(Context context,long now){
  boolean held=microphoneHeld;
  long since=unsilencedSince;
  IndicatorLease.Loss loss=lease.verdict(now,leaseBoot(context),IndicatorLease.requiresAttribution(held&&since>=0,since,now),screenInteractive);
  boolean valid=loss==IndicatorLease.Loss.NONE;
  // An unexplained loss while capturing, or during an explained pause, latches; an explained one pauses.
  boolean paused=indicatorPause!=ListenerPolicy.IndicatorPause.NONE;
  // A lease lapsing while the phone sleeps through a display-off pause is not a loss (see sleepLapse).
  boolean asleep=IndicatorLease.sleepLapse(held,indicatorPause,loss);
  if(!asleep&&ListenerPolicy.latchesIndicatorLoss(held||paused,valid,loss.pause()))indicatorLost=true;
  indicatorPause=asleep&&!screenInteractive?ListenerPolicy.IndicatorPause.DISPLAY_OFF:IndicatorLease.pauseFor(loss);
  return valid;
 }

 /** The listener's user (the primary user) is the one using the phone. Unknown counts as not. */
 private static boolean userForeground(UserManager users){
  try{return users!=null&&users.isUserForeground();}catch(RuntimeException unavailable){return false;}
 }

 /** Pause deadlines are on the monotonic clock, so a wall-clock change cannot end a pause early. */
 static ListenerPolicy.State state(Context context){return ListenerPolicy.decide(inputs(context),SystemClock.elapsedRealtime());}

 static final ListeningEpoch epoch=new ListeningEpoch();

 static synchronized void refresh(Context context){
  // Invalidate synchronously with the control, before Android delivers service lifecycle events.
  epoch.invalidate();
  Context app=context.getApplicationContext();
  ListenerPolicy.State state=state(app);
  Intent service=new Intent().setComponent(SenseConfig.component(app,"ListeningService"));
  if(ListenerPolicy.foreground(state))app.startForegroundService(service);
  else app.stopService(service);
  ListenerNotifications.showStatus(app,state);
  try{TileService.requestListeningState(app,SenseConfig.component(app,"ListenerTileService"));}catch(RuntimeException unavailable){}
 }
}

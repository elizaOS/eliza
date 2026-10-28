package ai.eliza.sense;

import ai.eliza.sense.IndicatorLease.Loss;
import ai.eliza.sense.ListenerPolicy.Inputs;
import ai.eliza.sense.ListenerPolicy.State;

/**
 * Plain-JVM checks of the listener's SystemUI indicator health lease and how the policy uses it.
 * Not an Android, SystemUI, image or device test.
 */
public final class ListenerLeaseTest {
 private static void check(boolean condition,String name){if(!condition)throw new AssertionError(name);}
 static final long BOOT=7;

 private static Inputs ready(boolean leaseValid){
  Inputs in=new Inputs();
  in.consentVersion=ListenerPolicy.CONSENT_VERSION;in.enabled=true;in.recordAudioGranted=true;in.userUnlocked=true;
  in.notificationsVisible=true;in.userForeground=true;in.indicatorLeaseValid=leaseValid;
  return in;
 }

 /** One listener-side capture step: what Listener.observeIndicatorLease and the policy do together. */
 static final class Sim {
  final IndicatorLease lease=new IndicatorLease();
  boolean held,lost,interactive=true;long since=-1;
  ListenerPolicy.IndicatorPause pause=ListenerPolicy.IndicatorPause.NONE;
  Inputs paused(Inputs in){in.indicatorPause=ListenerPolicy.IndicatorPause.DISPLAY_OFF;return in;}
  State step(long now,Inputs base){
   Loss loss=lease.verdict(now,BOOT,IndicatorLease.requiresAttribution(held&&since>=0,since,now),interactive);
   boolean valid=loss==Loss.NONE;
   boolean asleep=IndicatorLease.sleepLapse(held,pause,loss);
   if(!asleep&&ListenerPolicy.latchesIndicatorLoss(held||pause!=ListenerPolicy.IndicatorPause.NONE,valid,loss.pause()))lost=true;
   pause=asleep&&!interactive?ListenerPolicy.IndicatorPause.DISPLAY_OFF:IndicatorLease.pauseFor(loss);
   base.indicatorLeaseValid=valid;base.indicatorLost=lost;base.indicatorPause=pause;
   State state=ListenerPolicy.decide(base,now);
   boolean hold=ListenerPolicy.holdsMicrophone(state);
   if(hold&&!held){held=true;since=now;}else if(!hold){held=false;since=-1;}
   return state;
  }
 }

 public static void main(String[] args){
  long t=1_000_000;
  // ---- no lease, pending lease ----
  IndicatorLease lease=new IndicatorLease();
  check(lease.verdict(t,BOOT,false)==Loss.NEVER_ACQUIRED,"a fresh process has no lease");
  check(ListenerPolicy.decide(ready(false),t)==State.INDICATOR_UNAVAILABLE,"no lease, no capture");
  check(!ListenerPolicy.holdsMicrophone(State.INDICATOR_UNAVAILABLE)&&!ListenerPolicy.foreground(State.INDICATOR_UNAVAILABLE)&&ListenerPolicy.needsAttention(State.INDICATOR_UNAVAILABLE),"waiting for the indicator holds nothing");
  long gen=lease.acquire(BOOT);
  check(lease.verdict(t,BOOT,false)==Loss.PENDING,"acquiring alone is not a visible acknowledgement");
  check(lease.renew(gen,t,BOOT,false,false,false)&&lease.verdict(t,BOOT,false)==Loss.PENDING,"a hidden first acknowledgement never makes the lease fresh");
  // ---- renewal ----
  check(lease.renew(gen,t,BOOT,true,false,false),"visible surface acknowledged");
  check(lease.permits(t,BOOT,false),"fresh lease permits starting capture");
  for(long now=t+IndicatorLease.RENEW_MS;now<=t+20*IndicatorLease.RENEW_MS;now+=IndicatorLease.RENEW_MS)check(lease.renew(gen,now,BOOT,true,true,true)&&lease.permits(now,BOOT,true),"steady renewals keep the lease: "+now);
  long last=t+20*IndicatorLease.RENEW_MS;
  check(lease.nextCheckDelay(last)<=IndicatorLease.RENEW_MS&&lease.nextCheckDelay(last+IndicatorLease.TTL_MS-10)<=50,"the watchdog re-checks no later than expiry");
  // ---- expiry ----
  check(lease.permits(last+IndicatorLease.TTL_MS-1,BOOT,true),"valid until the TTL");
  check(lease.verdict(last+IndicatorLease.TTL_MS,BOOT,true)==Loss.EXPIRED,"SystemUI that stops renewing loses the lease within the TTL");
  check(!lease.renew(gen,last+IndicatorLease.TTL_MS+1,BOOT,true,true,true),"an expired generation can never be renewed");
  check(lease.verdict(last+IndicatorLease.TTL_MS+1,BOOT,false)==Loss.EXPIRED,"still expired");
  IndicatorLease late=new IndicatorLease();long lg=late.acquire(BOOT);late.renew(lg,t,BOOT,true,false,false);
  check(!late.renew(lg,t+IndicatorLease.TTL_MS,BOOT,true,false,false)&&!late.permits(t+IndicatorLease.TTL_MS,BOOT,false),"a renewal arriving after expiry does not revive the lease");
  long fresh=lease.acquire(BOOT);
  check(fresh!=gen&&!lease.renew(gen,last+5000,BOOT,true,true,true),"a stale generation is refused after re-acquire");
  check(lease.renew(fresh,last+5000,BOOT,true,false,false)&&lease.permits(last+5000,BOOT,false),"a new generation must be acknowledged anew");
  // ---- hidden view, detached chip, unattributed capture ----
  lease=new IndicatorLease();gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,true,true,true);
  check(lease.permits(t,BOOT,true),"chip shown while SystemUI observes the recording");
  lease.renew(gen,t+100,BOOT,false,false,true);
  check(lease.verdict(t+100,BOOT,false)==Loss.SURFACE_HIDDEN,"a hidden or detached surface stops capture at once, not at expiry");
  lease.renew(gen,t+200,BOOT,true,false,true);
  check(lease.verdict(t+200,BOOT,false)==Loss.CHIP_HIDDEN,"recording observed but the chip not shown");
  lease.renew(gen,t+300,BOOT,true,false,false);
  check(lease.permits(t+300,BOOT,false)&&lease.verdict(t+300,BOOT,true)==Loss.UNATTRIBUTED,"after the grace period SystemUI must attribute and show the recording");
  check(!IndicatorLease.requiresAttribution(true,t,t+IndicatorLease.ATTRIBUTION_GRACE_MS-1)&&IndicatorLease.requiresAttribution(true,t,t+IndicatorLease.ATTRIBUTION_GRACE_MS),"attribution grace");
  check(!IndicatorLease.requiresAttribution(false,t,t+60_000)&&!IndicatorLease.requiresAttribution(true,-1,t),"silenced or closed capture needs no attribution");
  // ---- binder death and explicit revoke ----
  lease=new IndicatorLease();gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,true,true,true);
  lease.binderDied(gen-1);
  check(lease.permits(t,BOOT,true),"a stale death notice is ignored");
  lease.binderDied(gen);
  check(lease.verdict(t,BOOT,false)==Loss.BINDER_DIED,"SystemUI process death ends the lease immediately");
  check(!lease.renew(gen,t+1,BOOT,true,true,true),"nothing from the dead generation is accepted");
  gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,true,true,true);lease.revoke(gen);
  check(lease.verdict(t,BOOT,false)==Loss.REVOKED,"explicit revoke");
  gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,true,true,true);long replaced=lease.acquire(BOOT);
  check(lease.verdict(t,BOOT,false)==Loss.PENDING&&!lease.renew(gen,t,BOOT,true,true,true),"a second acquire replaces the first");
  lease.renew(replaced,t,BOOT,true,true,true);
  check(lease.permits(t,BOOT,true),"the replacement can be acknowledged");

  // ---- policy: loss while capturing latches; nothing resumes silently ----
  Sim sim=new Sim();
  check(sim.step(t,ready(false))==State.INDICATOR_UNAVAILABLE&&!sim.held,"no capture before SystemUI acknowledges");
  long g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false);
  check(sim.step(t,ready(false))==State.LISTENING&&sim.held,"capture starts with a fresh lease");
  sim.lease.renew(g,t+1000,BOOT,true,true,true);
  check(sim.step(t+3000,ready(false))==State.LISTENING,"attributed, visible capture continues");
  sim.lease.binderDied(g);
  check(sim.step(t+3001,ready(false))==State.STOPPED_INDICATOR_LOST&&!sim.held,"binder death while capturing stops capture");
  g=sim.lease.acquire(BOOT);sim.lease.renew(g,t+4000,BOOT,true,false,false);
  check(sim.step(t+4000,ready(false))==State.STOPPED_INDICATOR_LOST&&!sim.held,"a returning SystemUI lease never resumes capture by itself");
  check(!ListenerPolicy.foreground(State.STOPPED_INDICATOR_LOST)&&ListenerPolicy.needsAttention(State.STOPPED_INDICATOR_LOST),"stopped state releases the microphone and tells the user");
  Inputs paused=ready(false);paused.pausedUntilMs=ListenerPolicy.PAUSE_UNTIL_RESUMED;
  check(sim.step(t+4001,paused)==State.STOPPED_INDICATOR_LOST,"pausing does not clear the latch");
  sim.lost=false; // ListenerStore.resume or an explicit turn-on (user action, after unlock)
  check(sim.step(t+4002,ready(false))==State.LISTENING,"an explicit user resume with a fresh lease restarts");
  // expiry while capturing
  check(sim.step(t+4002+IndicatorLease.TTL_MS,ready(false))==State.STOPPED_INDICATOR_LOST,"expiry while capturing stops capture and latches");
  // hidden view while capturing
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false);sim.step(t,ready(false));
  sim.lease.renew(g,t+500,BOOT,false,false,true);
  check(sim.step(t+500,ready(false))==State.STOPPED_INDICATOR_LOST,"a hidden Listening surface stops capture");
  // unattributed capture (SystemUI cannot verify the listener or never sees the recording)
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false);sim.step(t,ready(false));
  sim.lease.renew(g,t+1000,BOOT,true,false,false);
  check(sim.step(t+1000,ready(false))==State.LISTENING,"within the attribution grace");
  sim.lease.renew(g,t+2000,BOOT,true,false,false);
  check(sim.step(t+IndicatorLease.ATTRIBUTION_GRACE_MS,ready(false))==State.STOPPED_INDICATOR_LOST,"unattributed capture stops after the grace period");
  // a loss while nothing was captured only withholds the next start
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false);
  sim.step(t,paused);sim.lease.revoke(g);
  check(sim.step(t+1,paused)==State.PAUSED_USER&&!sim.lost,"losing the lease while paused is not latched");
  check(sim.step(t+2,ready(false))==State.INDICATOR_UNAVAILABLE&&!sim.held,"resuming without a lease does not open the microphone");
  // silenced capture holds the microphone and also needs the lease
  Inputs silenced=ready(false);silenced.micSilenced=true;
  check(ListenerPolicy.decide(silenced,t)==State.INDICATOR_UNAVAILABLE,"silenced capture needs the lease too");

  // ---- screen off: AOD keeps listening, display fully off pauses and resumes ----
  final String ON=IndicatorLease.DISPLAY_ON,DOZE=IndicatorLease.DISPLAY_DOZE,OFF=IndicatorLease.DISPLAY_OFF;
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);
  check(sim.step(t,ready(false))==State.LISTENING,"listening with the screen on");
  for(long now=t+1000;now<=t+60_000;now+=1000){
   sim.lease.renew(g,now,BOOT,true,true,true,DOZE);
   check(sim.step(now,ready(false))==State.LISTENING&&sim.held,"AOD showing the chip keeps listening with the lease: "+now);
  }
  long off=t+61_000;
  sim.lease.renew(g,off,BOOT,false,false,true,OFF);
  check(sim.step(off,ready(false))==State.PAUSED_DISPLAY_OFF&&!sim.held&&!sim.lost,"display fully off (no AOD) pauses and releases the microphone without latching");
  check(ListenerPolicy.foreground(State.PAUSED_DISPLAY_OFF)&&!ListenerPolicy.holdsMicrophone(State.PAUSED_DISPLAY_OFF)&&!ListenerPolicy.needsAttention(State.PAUSED_DISPLAY_OFF),"the paused notification stays, the microphone does not");
  for(long now=off+1000;now<=off+120_000;now+=1000){
   check(sim.lease.renew(g,now,BOOT,false,false,false,OFF),"a live SystemUI keeps the lease while the screen is off");
   check(sim.step(now,ready(false))==State.PAUSED_DISPLAY_OFF,"stays paused while the display is off: "+now);
  }
  long wake=off+121_000;
  sim.lease.renew(g,wake,BOOT,true,false,false,ON);
  check(sim.step(wake,ready(false))==State.LISTENING&&sim.held,"a fresh lease from a visible lock-screen surface resumes after a display-off pause");
  sim.lease.renew(g,wake+1000,BOOT,true,true,true,ON);sim.step(wake+1000,ready(false));
  sim.lease.renew(g,wake+2000,BOOT,false,false,true,DOZE);
  check(sim.step(wake+2000,ready(false))==State.PAUSED_DISPLAY_OFF,"AOD that does not show the indicator pauses like a dark display");
  sim.lease.renew(g,wake+3000,BOOT,true,true,true,DOZE);
  check(sim.step(wake+3000,ready(false))==State.LISTENING,"and resumes when AOD shows it");
  check(sim.step(wake+3000+IndicatorLease.TTL_MS,ready(false))==State.STOPPED_INDICATOR_LOST,"SystemUI silence while dozing is still a loss");
  // the phone sleeping through a display-off pause: SystemUI's renewals stop, the lease lapses,
  // and on wake SystemUI acquires a new pending generation. None of that latches; capture resumes
  // only on a fresh visible acknowledgement. A lapse while the microphone is held still latches.
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);
  check(sim.step(t,ready(false))==State.LISTENING,"listening before sleep");
  sim.lease.renew(g,t+1000,BOOT,false,false,false,OFF);sim.interactive=false;
  check(sim.step(t+1000,ready(false))==State.PAUSED_DISPLAY_OFF&&!sim.held,"display off pauses before sleep");
  for(long now=t+2000;now<=t+120_000;now+=7000)
   check(sim.step(now,ready(false))==State.PAUSED_DISPLAY_OFF&&!sim.lost&&!sim.held,"asleep with no renewals stays paused, not lost: "+now);
  check(!sim.lease.renew(g,t+121_000,BOOT,true,false,false,ON),"the lapsed generation cannot be renewed after sleep");
  sim.interactive=true;
  check(sim.step(t+121_000,ready(false))==State.INDICATOR_UNAVAILABLE&&!sim.lost&&!sim.held,"on wake without a fresh lease nothing is captured and nothing is latched");
  long woke=sim.lease.acquire(BOOT);
  check(sim.step(t+121_100,ready(false))==State.INDICATOR_UNAVAILABLE&&!sim.lost,"a re-acquired pending lease after sleep is not a loss");
  sim.lease.renew(woke,t+121_200,BOOT,true,false,false,ON);
  check(sim.step(t+121_200,ready(false))==State.LISTENING&&sim.held,"a fresh visible acknowledgement after sleep resumes listening");
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,OFF);sim.interactive=false;
  sim.step(t,ready(false));
  check(sim.step(t+IndicatorLease.TTL_MS+1,ready(false))!=State.STOPPED_INDICATOR_LOST,"a lapse after the display-off pause released the microphone is not latched");
  check(!IndicatorLease.sleepLapse(true,ListenerPolicy.IndicatorPause.DISPLAY_OFF,Loss.EXPIRED),"a lapse while the microphone is held is never a sleep lapse");
  check(!IndicatorLease.sleepLapse(false,ListenerPolicy.IndicatorPause.FULLSCREEN,Loss.EXPIRED),"only a display-off pause explains a lapse");
  check(!IndicatorLease.sleepLapse(false,ListenerPolicy.IndicatorPause.DISPLAY_OFF,Loss.BINDER_DIED),"SystemUI dying is never a sleep lapse");
  // indicator lost while the display is on stays sticky across display changes
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  sim.lease.renew(g,t+500,BOOT,false,false,true,ON);
  check(sim.step(t+500,ready(false))==State.STOPPED_INDICATOR_LOST,"surface hidden with the display on is a sticky loss");
  sim.lease.renew(g,t+1500,BOOT,false,false,false,OFF);
  check(sim.step(t+1500,ready(false))==State.STOPPED_INDICATOR_LOST,"turning the display off does not convert a loss into a pause");
  sim.lease.renew(g,t+2500,BOOT,true,false,false,DOZE);
  check(sim.step(t+2500,ready(false))==State.STOPPED_INDICATOR_LOST,"a visible AOD surface afterwards does not resume a loss");
  // unknown or missing display state: a pause only when the listener itself sees the screen off
  lease=new IndicatorLease();gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,true,true,true,"unknown");
  check(lease.verdict(t,BOOT,false,true)==Loss.UNKNOWN_STATE&&!Loss.UNKNOWN_STATE.pause(),"unknown display state with the screen on is unexplained");
  check(lease.verdict(t,BOOT,false,false)==Loss.DISPLAY_OFF,"unknown display state with the screen off is a display-off pause");
  lease.renew(gen,t,BOOT,true,true,true,null);
  check(lease.verdict(t,BOOT,false,true)==Loss.UNKNOWN_STATE,"missing display state with the screen on is unexplained");
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  sim.lease.renew(g,t+500,BOOT,true,true,true,null);
  check(sim.step(t+500,ready(false))==State.STOPPED_INDICATOR_LOST,"unknown state while the screen is on stops capture (sticky)");

  // ---- explained hidden indicator: pause and resume; unexplained: sticky ----
  final String FULL=IndicatorLease.REASON_FULLSCREEN,SHADE=IndicatorLease.REASON_SHADE,TRANS=IndicatorLease.REASON_TRANSITION,NONE=IndicatorLease.REASON_NONE;
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  sim.lease.renew(g,t+1000,BOOT,false,false,true,ON,FULL);
  check(sim.step(t+1000,ready(false))==State.PAUSED_FULLSCREEN&&!sim.held&&!sim.lost,"immersive app hides the status bar: pause, microphone released, not latched");
  for(long now=t+2000;now<=t+60_000;now+=1000){
   check(sim.lease.renew(g,now,BOOT,false,false,false,ON,FULL)&&sim.step(now,ready(false))==State.PAUSED_FULLSCREEN&&!sim.held,"stays paused while fullscreen: "+now);
  }
  sim.lease.renew(g,t+61_000,BOOT,true,false,false,ON,NONE);
  check(sim.step(t+61_000,ready(false))==State.LISTENING&&sim.held,"status bar shown again: resumes on a fresh visible lease");
  sim.lease.renew(g,t+62_000,BOOT,false,false,true,ON,SHADE);
  check(sim.step(t+62_000,ready(false))==State.PAUSED_SHADE&&!sim.held&&!sim.lost,"shade expanded without the listening notification: pause");
  sim.lease.renew(g,t+63_000,BOOT,true,false,false,ON,NONE);
  check(sim.step(t+63_000,ready(false))==State.LISTENING,"shade closed: resumes");
  sim.lease.renew(g,t+64_000,BOOT,false,false,true,ON,TRANS);
  check(sim.step(t+64_000,ready(false))==State.PAUSED_TRANSITION&&!sim.held&&!sim.lost,"hidden within the transition debounce: pause");
  sim.lease.renew(g,t+64_500,BOOT,true,false,false,ON,NONE);
  check(sim.step(t+64_500,ready(false))==State.LISTENING,"the lock screen chip after the transition resumes");
  sim.lease.renew(g,t+65_000,BOOT,false,false,true,ON,FULL);sim.step(t+65_000,ready(false));
  check(sim.step(t+65_000+IndicatorLease.TTL_MS,ready(false))==State.STOPPED_INDICATOR_LOST,"expiry during an explained pause (SystemUI stopped reporting) is an unexplained loss");
  // SystemUI death, unexplained hidden surface, detached chip and an unknown reason stay sticky
  for(String why:new String[]{NONE,"detached","bogus",null}){
   sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
   sim.lease.renew(g,t+500,BOOT,false,false,true,ON,why);
   check(sim.step(t+500,ready(false))==State.STOPPED_INDICATOR_LOST,"hidden without an explained reason is sticky: "+why);
   sim.lease.renew(g,t+1500,BOOT,true,true,true,ON,NONE);
   check(sim.step(t+1500,ready(false))==State.STOPPED_INDICATOR_LOST,"and a visible lease afterwards does not resume it: "+why);
  }
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  sim.lease.binderDied(g);
  check(sim.step(t+1,ready(false))==State.STOPPED_INDICATOR_LOST,"SystemUI death is sticky");
  g=sim.lease.acquire(BOOT);sim.lease.renew(g,t+2,BOOT,false,false,false,ON,FULL);
  check(sim.step(t+2,ready(false))==State.STOPPED_INDICATOR_LOST,"a later explained report does not turn death into a pause");
  sim.lease.renew(g,t+3,BOOT,true,true,true,ON,NONE);
  check(sim.step(t+3,ready(false))==State.STOPPED_INDICATOR_LOST,"nor does a visible one");
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  sim.lease.revoke(g);
  check(sim.step(t+1,ready(false))==State.STOPPED_INDICATOR_LOST,"explicit revoke (unverified identity) is sticky");
  sim=new Sim();g=sim.lease.acquire(BOOT);sim.lease.renew(g,t,BOOT,true,false,false,ON);sim.step(t,ready(false));
  check(sim.step(t+IndicatorLease.TTL_MS,ready(false))==State.STOPPED_INDICATOR_LOST,"expiry with no report is sticky");
  // the explained pause states release everything and are foreground with their own text
  for(State state:new State[]{State.PAUSED_FULLSCREEN,State.PAUSED_SHADE,State.PAUSED_TRANSITION,State.PAUSED_DISPLAY_OFF})
   check(ListenerPolicy.indicatorPaused(state)&&ListenerPolicy.foreground(state)&&!ListenerPolicy.holdsMicrophone(state)&&!ListenerPolicy.processesAudio(state),"pause releases capture: "+state);
  check(ListenerPolicy.label(State.PAUSED_FULLSCREEN).equals("Paused while an app is fullscreen"),"fullscreen status text");
  lease=new IndicatorLease();gen=lease.acquire(BOOT);lease.renew(gen,t,BOOT,false,false,false,OFF);
  check(lease.verdict(t,BOOT,false)==Loss.DISPLAY_OFF&&ListenerPolicy.decide(sim.paused(ready(false)),t)==State.PAUSED_DISPLAY_OFF,"opting in with the screen off waits paused, not capturing");

  // ---- reboot before unlock ----
  IndicatorLease boot=new IndicatorLease();long bg=boot.acquire(BOOT);boot.renew(bg,t,BOOT,true,false,false);
  Inputs locked=ready(true);locked.userUnlocked=false;
  check(ListenerPolicy.decide(locked,t)==State.WAITING_FOR_UNLOCK,"a fresh lease never captures before first unlock");
  locked.indicatorLost=true;
  check(ListenerPolicy.decide(locked,t)!=State.LISTENING,"nothing captures before unlock");
  check(boot.verdict(t,BOOT+1,false)==Loss.OTHER_BOOT&&!boot.renew(bg,t,BOOT+1,true,true,true),"a lease from another boot never counts");
  Inputs rebooted=ready(true);rebooted.consentVersion=0;
  check(ListenerPolicy.decide(rebooted,t)==State.OFF,"a restarted process without fresh opt-in is off whatever the lease");

  // ---- crash-loop interaction ----
  Inputs crashed=ready(true);crashed.crashLoopTripped=true;
  check(ListenerPolicy.decide(crashed,t)==State.STOPPED_AFTER_ERRORS,"a fresh lease never overrides the crash-loop breaker");
  crashed.indicatorLost=true;
  check(ListenerPolicy.decide(crashed,t)==State.STOPPED_AFTER_ERRORS,"crash loop reported before a lost indicator");
  Inputs lostOnly=ready(true);lostOnly.indicatorLost=true;
  check(ListenerPolicy.decide(lostOnly,t)==State.STOPPED_INDICATOR_LOST,"lost indicator is sticky even with a fresh lease");
  // Lease loss stops capture cleanly (the session marker is closed), so repeated SystemUI loss never counts as listener crashes.
  long[] exits=new long[0];
  for(int i=0;i<10;i++)exits=CrashLoopBreaker.onProcessStart(exits,false,t+i);
  check(!CrashLoopBreaker.tripped(exits,t+10),"lease losses are clean stops, not unclean exits");

  // ---- who may hold the lease ----
  String[] systemui={IndicatorLease.SYSTEMUI_PACKAGE};
  check(IndicatorLease.admitsController(true,10_123,systemui,true),"platform-signed SystemUI in user 0");
  check(!IndicatorLease.admitsController(false,10_123,systemui,true),"without STATUS_BAR_SERVICE");
  check(!IndicatorLease.admitsController(true,10_123,new String[]{"ai.elizaresearch.alphaphone"},false),"Alpha cannot renew");
  check(!IndicatorLease.admitsController(true,10_123,systemui,false),"a non-platform package named like SystemUI");
  check(!IndicatorLease.admitsController(true,1_010_123,systemui,true),"another user's SystemUI");
  check(!IndicatorLease.admitsController(true,10_123,new String[]{IndicatorLease.SYSTEMUI_PACKAGE,"other"},true),"shared UID");
  check(!IndicatorLease.admitsController(true,10_123,null,true),"unknown UID");

  // ---- labels ----
  for(State state:new State[]{State.INDICATOR_UNAVAILABLE,State.STOPPED_INDICATOR_LOST,State.PAUSED_DISPLAY_OFF,State.PAUSED_FULLSCREEN,State.PAUSED_SHADE,State.PAUSED_TRANSITION}){String label=ListenerPolicy.label(state);check(label!=null&&label.length()<64,"label "+state);}
  System.out.println("PASS listener indicator lease: renewal, expiry, binder death, hidden view, display off/AOD, explained pauses, reboot, crash loop");
 }
}

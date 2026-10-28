package ai.eliza.sense;

import ai.eliza.sense.ListenerPolicy.Inputs;
import ai.eliza.sense.ListenerPolicy.State;
import java.util.ArrayList;
import java.util.List;

/** Plain-JVM checks of the always-on listener's pure policy. Not an Android, image or device test. */
public final class ListenerPolicyTest {
 private static void check(boolean condition,String name){if(!condition)throw new AssertionError(name);}

 private static Inputs ready(){
  Inputs in=new Inputs();
  in.consentVersion=ListenerPolicy.CONSENT_VERSION;in.enabled=true;in.recordAudioGranted=true;in.userUnlocked=true;
  in.notificationsVisible=true;in.userForeground=true;in.indicatorLeaseValid=true;
  return in;
 }

 private static short[] tone(double amplitude,int frame){
  short[] out=new short[SpeechGate.FRAME_SAMPLES];
  for(int i=0;i<out.length;i++)out[i]=(short)Math.round(amplitude*32767*Math.sin(2*Math.PI*220*(frame*out.length+i)/SpeechGate.SAMPLE_RATE));
  return out;
 }

 public static void main(String[] args){
  long now=1_800_000_000_000L;
  // ---- default off and consent ----
  check(ListenerPolicy.decide(new Inputs(),now)==State.OFF,"defaults are off");
  check(ListenerPolicy.decide(null,now)==State.OFF,"no inputs is off");
  Inputs in=ready();in.consentVersion=0;
  check(ListenerPolicy.decide(in,now)==State.OFF,"no consent is off");
  in.consentVersion=ListenerPolicy.CONSENT_VERSION+1;
  check(ListenerPolicy.decide(in,now)==State.OFF,"a different consent version lapses");
  in=ready();in.enabled=false;
  check(ListenerPolicy.decide(in,now)==State.OFF,"turned off by the user");
  check(ListenerPolicy.decide(ready(),now)==State.LISTENING,"consented, granted, unlocked listens");
  // ---- revocation, crash loop, before-first-unlock and model ----
  in=ready();in.recordAudioGranted=false;
  check(ListenerPolicy.decide(in,now)==State.PERMISSION_REQUIRED,"revoked RECORD_AUDIO never captures");
  in=ready();in.crashLoopTripped=true;in.userUnlocked=false;
  check(ListenerPolicy.decide(in,now)==State.STOPPED_AFTER_ERRORS,"crash loop wins over everything but consent/permission");
  in=ready();in.userUnlocked=false;
  check(ListenerPolicy.decide(in,now)==State.WAITING_FOR_UNLOCK,"before first unlock never captures");
  in=ready();in.speechUnavailable=true;
  check(ListenerPolicy.decide(in,now)==State.SPEECH_UNAVAILABLE,"no local model never captures");
  // ---- visible indicator ----
  in=ready();in.notificationsVisible=false;
  check(ListenerPolicy.decide(in,now)==State.NOTIFICATIONS_REQUIRED,"no visible notification, no listening");
  check(!ListenerPolicy.foreground(State.NOTIFICATIONS_REQUIRED)&&!ListenerPolicy.holdsMicrophone(State.NOTIFICATIONS_REQUIRED)&&ListenerPolicy.needsAttention(State.NOTIFICATIONS_REQUIRED),"indicator missing holds nothing");
  in.speechUnavailable=true;in.inCall=true;
  check(ListenerPolicy.decide(in,now)==State.NOTIFICATIONS_REQUIRED,"the indicator check precedes every capturing state");
  check(ListenerPolicy.notificationsVisible(true,true,ListenerPolicy.IMPORTANCE_DEFAULT,false,true),"granted, enabled, DEFAULT channel, shown on lock screen");
  check(!ListenerPolicy.notificationsVisible(true,true,ListenerPolicy.IMPORTANCE_LOW,false,true),"channel lowered to silent (may be hidden on the lock screen)");
  check(ListenerPolicy.notificationsVisible(true,true,4,false,true),"higher importance");
  check(!ListenerPolicy.notificationsVisible(false,true,3,false,true),"POST_NOTIFICATIONS denied");
  check(!ListenerPolicy.notificationsVisible(true,false,3,false,true),"app notifications blocked");
  check(!ListenerPolicy.notificationsVisible(true,true,ListenerPolicy.IMPORTANCE_NONE,false,true),"channel blocked");
  check(!ListenerPolicy.notificationsVisible(true,true,ListenerPolicy.IMPORTANCE_MIN,false,true),"channel minimised (hidden on the lock screen)");
  check(!ListenerPolicy.notificationsVisible(true,true,3,true,true),"channel hidden on the lock screen");
  check(!ListenerPolicy.notificationsVisible(true,true,3,false,false),"lock-screen notifications turned off device-wide");
  check(ListenerPolicy.INDICATOR_RECHECK_MS>0&&ListenerPolicy.INDICATOR_RECHECK_MS<=30_000,"indicator re-checked while capturing");
  check(ListenerPolicy.consentPermissionsGranted(true,true),"consent with both permissions");
  check(!ListenerPolicy.consentPermissionsGranted(true,false)&&!ListenerPolicy.consentPermissionsGranted(false,true),"consent needs microphone and notifications");
  // ---- user switching ----
  in=ready();in.userForeground=false;
  check(ListenerPolicy.decide(in,now)==State.PAUSED_OTHER_USER,"another user in the foreground stops capture");
  check(!ListenerPolicy.foreground(State.PAUSED_OTHER_USER)&&!ListenerPolicy.holdsMicrophone(State.PAUSED_OTHER_USER),"nothing runs for a background user");
  in.userUnlocked=false;
  check(ListenerPolicy.decide(in,now)==State.PAUSED_OTHER_USER,"a background user's listener never waits to capture");
  // ---- keyguard, ringing and echo ----
  check(!ListenerPolicy.mayInvokeAssistant(true)&&ListenerPolicy.mayInvokeAssistant(false),"wake phrase opens Alpha only when unlocked");
  check(!ListenerPolicy.callMode(0)&&!ListenerPolicy.callMode(-1)&&!ListenerPolicy.callMode(-2)&&!ListenerPolicy.callMode(7),"normal and unknown modes");
  for(int mode=1;mode<=6;mode++)check(ListenerPolicy.callMode(mode),"ringing and call modes pause: "+mode);
  for(int usage:new int[]{0,1,2,3,11,12,14,16,99})check(ListenerPolicy.playbackSuppressesWake(usage),"speech-capable or unknown playback suppresses: "+usage);
  for(int usage:new int[]{4,5,6,7,8,9,10,13})check(!ListenerPolicy.playbackSuppressesWake(usage),"short system sounds do not: "+usage);
  // ---- pause clock ----
  check(ListenerPolicy.effectivePause(0,3,3)==0,"no pause");
  check(ListenerPolicy.effectivePause(ListenerPolicy.PAUSE_UNTIL_RESUMED,-1,3)==ListenerPolicy.PAUSE_UNTIL_RESUMED,"pause until resumed survives reboot");
  check(ListenerPolicy.effectivePause(5000,3,3)==5000,"timed pause in this boot");
  check(ListenerPolicy.effectivePause(5000,3,4)==ListenerPolicy.PAUSE_UNTIL_RESUMED,"timed pause from an earlier boot lasts until resumed");
  check(ListenerPolicy.effectivePause(5000,-1,-1)==ListenerPolicy.PAUSE_UNTIL_RESUMED,"unknown boot keeps the pause");
  // ---- pauses ----
  in=ready();in.pausedUntilMs=ListenerPolicy.pauseUntil(now,15);
  check(ListenerPolicy.decide(in,now)==State.PAUSED_USER,"timed pause");
  check(ListenerPolicy.decide(in,now+15*60_000L)==State.LISTENING,"timed pause ends");
  in.pausedUntilMs=ListenerPolicy.pauseUntil(now,0);
  check(in.pausedUntilMs==ListenerPolicy.PAUSE_UNTIL_RESUMED&&ListenerPolicy.decide(in,Long.MAX_VALUE-1)==State.PAUSED_USER,"pause until resumed");
  check(ListenerPolicy.pauseUntil(Long.MAX_VALUE-10,60)==ListenerPolicy.PAUSE_UNTIL_RESUMED,"no overflow");
  in=ready();in.inCall=true;in.micSilenced=true;
  check(ListenerPolicy.decide(in,now)==State.PAUSED_CALL,"calls pause capture");
  in=ready();in.otherAppRecording=true;in.micSilenced=true;
  check(ListenerPolicy.decide(in,now)==State.PAUSED_MIC_IN_USE,"another app recording pauses and releases");
  check(!ListenerPolicy.holdsMicrophone(State.PAUSED_MIC_IN_USE),"the listener never competes with another recording app");
  in=ready();in.micSilenced=true;
  check(ListenerPolicy.decide(in,now)==State.PAUSED_MIC_UNAVAILABLE,"silenced microphone (privacy toggle) pauses");
  // ---- what each state may do ----
  for(State state:State.values()){
   check(ListenerPolicy.processesAudio(state)==(state==State.LISTENING),"only LISTENING processes audio: "+state);
   if(ListenerPolicy.holdsMicrophone(state))check(ListenerPolicy.foreground(state),"an open microphone always has the foreground indicator: "+state);
   check(!(ListenerPolicy.foreground(state)&&ListenerPolicy.needsAttention(state)),"foreground and attention are distinct: "+state);
   String label=ListenerPolicy.label(state);
   check(label!=null&&!label.isEmpty()&&label.length()<64,"lock-screen-safe label: "+state);
  }
  check(!ListenerPolicy.holdsMicrophone(State.PAUSED_USER)&&!ListenerPolicy.holdsMicrophone(State.PAUSED_CALL),"user and call pauses release the microphone");
  check(!ListenerPolicy.foreground(State.OFF)&&!ListenerPolicy.holdsMicrophone(State.WAITING_FOR_UNLOCK),"off and before-unlock hold nothing");

  // ---- crash-loop breaker ----
  long[] exits=new long[0];
  exits=CrashLoopBreaker.onProcessStart(exits,false,now);
  check(exits.length==0,"a clean start is not an exit");
  for(int i=0;i<CrashLoopBreaker.LIMIT-1;i++)exits=CrashLoopBreaker.onProcessStart(exits,true,now+i*1000);
  check(!CrashLoopBreaker.tripped(exits,now+5000),"below the limit");
  exits=CrashLoopBreaker.onProcessStart(exits,true,now+5000);
  check(CrashLoopBreaker.tripped(exits,now+5000),"limit inside the window trips");
  check(!CrashLoopBreaker.tripped(exits,now+5000+CrashLoopBreaker.WINDOW_MS),"old exits age out");
  check(CrashLoopBreaker.decode(CrashLoopBreaker.encode(exits)).length==exits.length,"round trip");
  check(CrashLoopBreaker.decode("x,-4,,12").length==1,"malformed store entries are dropped");
  check(CrashLoopBreaker.decode(null).length==0&&CrashLoopBreaker.prune(null,now).length==0,"absent store");
  long[] many=new long[0];for(int i=0;i<40;i++)many=CrashLoopBreaker.onProcessStart(many,true,now+i);
  check(many.length==CrashLoopBreaker.KEEP,"bounded history");
  check(CrashLoopBreaker.prune(new long[]{now+60_000},now).length==0,"future timestamps (clock change) are ignored");
  check(!CrashLoopBreaker.uncleanExit(false,7,7,100,100),"no open session");
  check(CrashLoopBreaker.uncleanExit(true,7,7,100,100),"session left open in this boot by this install is a crash");
  check(!CrashLoopBreaker.uncleanExit(true,7,8,100,100),"a reboot, shutdown or OTA is not a crash");
  check(!CrashLoopBreaker.uncleanExit(true,7,7,100,200),"a package update is not a crash");
  check(CrashLoopBreaker.uncleanExit(true,-1,8,100,100)&&CrashLoopBreaker.uncleanExit(true,7,-1,100,100),"unknown boot count is counted conservatively");
  long[] reboots=new long[0];
  for(int i=0;i<5;i++)reboots=CrashLoopBreaker.onProcessStart(reboots,CrashLoopBreaker.uncleanExit(true,i,i+1,100,100),now+i*1000);
  check(!CrashLoopBreaker.tripped(reboots,now+5000),"five reboots in a minute never trip the breaker");

  // ---- wake phrase ----
  check(WakePhrase.classify("Alpha, what's on my calendar?")==WakePhrase.Action.INVOKE,"name first");
  check(WakePhrase.classify("hey alpha")==WakePhrase.Action.INVOKE,"greeting then name");
  check(WakePhrase.classify("OK ALPHA.")==WakePhrase.Action.INVOKE,"case and punctuation");
  check(WakePhrase.classify("Alpha, stop listening.")==WakePhrase.Action.PAUSE_LISTENING,"voice pause");
  check(WakePhrase.classify("hey alpha pause")==WakePhrase.Action.PAUSE_LISTENING,"short voice pause");
  check(WakePhrase.classify("Alpha stop listening to the radio")==WakePhrase.Action.INVOKE,"only exact pause commands pause");
  for(String other:new String[]{"","   ",null,"the alpha version is out","I told alpha","alphabet soup","hey","hey hey alpha","stop listening","alpha".repeat(1)+" "+"word ".repeat(80)})
   check(WakePhrase.classify(other)==WakePhrase.Action.IGNORE,"not addressed: "+other);

  // ---- speech gate ----
  List<float[]> out=new ArrayList<>();
  SpeechGate gate=new SpeechGate(out::add);
  int frame=0;
  for(int i=0;i<100;i++)gate.accept(tone(0.0005,frame++)); // quiet room
  check(out.isEmpty(),"silence yields nothing");
  for(int i=0;i<5;i++)gate.accept(tone(0.3,frame++));
  for(int i=0;i<60;i++)gate.accept(tone(0.0005,frame++));
  check(out.isEmpty(),"a 100 ms click is discarded");
  for(int i=0;i<50;i++)gate.accept(tone(0.3,frame++)); // 1 s of speech
  for(int i=0;i<SpeechGate.HANGOVER_FRAMES;i++)gate.accept(tone(0.0005,frame++));
  check(out.size()==1,"one utterance after the hangover");
  int samples=out.get(0).length;
  check(samples>=50*SpeechGate.FRAME_SAMPLES&&samples<=(50+SpeechGate.PREROLL_FRAMES+1)*SpeechGate.FRAME_SAMPLES,"utterance keeps pre-roll and drops the trailing silence: "+samples);
  out.clear();
  for(int i=0;i<SpeechGate.MAX_FRAMES+50;i++)gate.accept(tone(0.3,frame++));
  check(out.size()==1&&out.get(0).length<=SpeechGate.MAX_FRAMES*SpeechGate.FRAME_SAMPLES,"long speech is capped");
  out.clear();
  gate.reset();
  for(int i=0;i<30;i++)gate.accept(tone(0.3,frame++));
  gate.reset();
  for(int i=0;i<SpeechGate.HANGOVER_FRAMES+5;i++)gate.accept(new short[SpeechGate.FRAME_SAMPLES]);
  check(out.isEmpty(),"reset drops a partial utterance");
  // The floor adapts: steady loud noise stops counting as speech.
  SpeechGate adaptive=new SpeechGate(out::add);
  for(int i=0;i<2000;i++)adaptive.accept(tone(0.0005,i));
  double quiet=adaptive.noiseFloorDb();
  check(quiet<-60,"floor follows a quiet room: "+quiet);
  for(int i=0;i<20_000;i++)adaptive.accept(tone(0.05,i));
  check(adaptive.noiseFloorDb()>-40,"floor rises under steady loud noise: "+adaptive.noiseFloorDb());
  int before=out.size();
  for(int i=0;i<2000;i++)adaptive.accept(tone(0.05,i));
  check(out.size()==before,"steady noise stops producing utterances");
  boolean threw=false;try{gate.accept(new short[10]);}catch(IllegalArgumentException expected){threw=true;}
  check(threw,"wrong frame size is refused");
  check(SpeechGate.levelDbfs(new short[SpeechGate.FRAME_SAMPLES],0,SpeechGate.FRAME_SAMPLES)==-120.0,"digital silence");

  System.out.println("PASS listener policy");
 }
}

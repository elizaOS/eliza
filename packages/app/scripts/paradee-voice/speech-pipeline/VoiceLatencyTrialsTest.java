package ai.eliza.voice;

import java.util.List;

/** Host-JVM check of the latency trial state. Not Android, audio or timing evidence. */
public final class VoiceLatencyTrialsTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static final long MS=1_000_000L;
 public static void main(String[] args){
  // AudioTimestamp: frame 16000 one second after a (frame 0, 5 s) anchor at 16 kHz.
  check(VoiceLatencyTrials.frameTimeNs(5_000*MS,0,16_000,16_000)==6_000*MS,"frame to monotonic time");
  check(VoiceLatencyTrials.frameTimeNs(5_000*MS,32_000,31_999,16_000)==5_000*MS-62_500,"frames before the anchor");
  // MediaTimestamp: media 300 ms presented at 10 s; media 20 ms (the lead-in) at 9.72 s at rate 1, 9.86 s at rate 2.
  check(VoiceLatencyTrials.presentationNs(10_000*MS,300_000,20_000,1f)==9_720*MS,"presentation at rate 1");
  check(VoiceLatencyTrials.presentationNs(10_000*MS,300_000,20_000,2f)==9_860*MS,"presentation scales with the clock rate");
  long[] now={0};
  VoiceLatencyTrials trials=new VoiceLatencyTrials(()->now[0]);
  check(trials.speechEnded(VoiceLatencyTrials.UNSET,10*MS,"audiorecord-timestamp","live-voice")==null,"no speech sample, no trial");
  check(trials.speechEnded(20*MS,10*MS,"audiorecord-timestamp","live-voice")==null,"the last speech sample cannot follow the endpoint");
  check(trials.firstPcm(trials.pending(),5*MS)==null,"playback without an open turn is not a trial");

  now[0]=600*MS;
  VoiceLatencyTrials.Trial first=trials.speechEnded(100*MS,600*MS,"audiorecord-timestamp","live-voice");
  check(first!=null&&first.cold&&"process-first-turn".equals(first.coldReason),"the first turn of the process is cold");
  check(!trials.mark(trials.pending(),"tts-start",500*MS),"a stage mark before the endpoint is refused");
  check(trials.mark(trials.pending(),"tts-start",900*MS)&&!trials.mark(trials.pending(),"tts-start",950*MS),"stage marks are stamped once");
  check(!trials.mark(trials.pending(),"first-pcm",1000*MS)&&!trials.mark(trials.pending(),"endpoint",1000*MS),"turn and playback marks are not generic stage marks");
  check(trials.mark(trials.pending(),"tts-ready",1100*MS),"tts-ready");
  trials.engineLoaded(trials.pending(),"tts-load");
  check("process-first-turn+tts-load".equals(first.coldReason),"cold reasons accumulate");
  VoiceLatencyTrials.Trial playing=trials.firstPcm(trials.pending(),1200*MS);
  check(playing==first&&trials.firstPcm(trials.pending(),1300*MS)==null,"first-pcm belongs to the open turn, once");
  check(!trials.audible(first,1150*MS,"mediaplayer-timestamp"),"audible cannot precede first-pcm");
  check(trials.audible(first,1350*MS,"mediaplayer-timestamp"),"audible completes the trial");
  check("passed".equals(trials.outcome(first))&&Math.abs(first.latencyMs()-1250)<1e-9,"latency is audible minus last speech: 1250 ms");
  check(trials.pending()==null&&!trials.audible(first,1400*MS,"x"),"a finished trial cannot be stamped again");

  now[0]=2000*MS;
  VoiceLatencyTrials.Trial second=trials.speechEnded(1500*MS,2000*MS,"read-return","live-voice");
  check(!second.cold,"later turns are warm unless an engine loads");
  VoiceLatencyTrials.Trial third=trials.speechEnded(2500*MS,3000*MS,"audiorecord-timestamp","live-voice");
  check("abandoned".equals(second.outcome)&&"superseded".equals(second.reason),"a newer turn supersedes one without a response");
  trials.firstPcm(trials.pending(),3100*MS);
  // A turn ending during that reply fails it, and the next playback cannot count for the new turn.
  now[0]=3200*MS;
  VoiceLatencyTrials.Trial barge=trials.speechEnded(3150*MS,3200*MS,"audiorecord-timestamp","live-voice");
  check("failed".equals(third.outcome)&&"superseded-during-reply".equals(third.reason)&&barge.overlapped,"superseded during the reply");
  VoiceLatencyTrials.Trial late=trials.firstPcm(trials.pending(),3300*MS);
  check(late==barge&&trials.audible(barge,3400*MS,"mediaplayer-timestamp")&&"failed".equals(barge.outcome)&&"overlapping-reply".equals(barge.reason),"an overlapped turn fails instead of passing");
  third=trials.speechEnded(3500*MS,3600*MS,"audiorecord-timestamp","live-voice");
  trials.firstPcm(trials.pending(),3700*MS);
  now[0]=3700*MS+VoiceLatencyTrials.PENDING_LIMIT_NS+1;
  check(trials.pending()==null&&"failed".equals(third.outcome)&&"no-audible-time".equals(third.reason),"playback with no audible time fails after the limit");
  // An abandoned cold turn hands its cold flag to the next one.
  VoiceLatencyTrials fresh=new VoiceLatencyTrials(()->0L);
  fresh.speechEnded(0,MS,"audiorecord-timestamp","live-voice");
  VoiceLatencyTrials.Trial next=fresh.speechEnded(2*MS,3*MS,"audiorecord-timestamp","live-voice");
  check(next.cold&&"process-first-turn".equals(next.coldReason),"the first real turn stays cold after a noise segment");

  VoiceLatencyTrials.Trial fourth=trials.speechEnded(now[0]-10*MS,now[0],"audiorecord-timestamp","harness-no-inference");
  now[0]+=VoiceLatencyTrials.PENDING_LIMIT_NS+1;
  check(trials.pending()==null&&"abandoned".equals(fourth.outcome)&&"no-response".equals(fourth.reason),"a turn with no response is abandoned, not failed");
  VoiceLatencyTrials.Trial fifth=trials.speechEnded(now[0]-10*MS,now[0],"audiorecord-timestamp","live-voice");
  trials.failed(fifth,"playback-stopped");
  check("failed".equals(fifth.outcome),"explicit failure");

  List<VoiceLatencyTrials.Trial> done=trials.snapshot();
  check(done.size()==7&&done.get(0)==first,"finished trials in order");
  for(int i=0;i<VoiceLatencyTrials.MAX_RECORDS+3;i++){long at=now[0]+i*MS;trials.speechEnded(at,at,"audiorecord-timestamp","live-voice");}
  check(trials.snapshot().size()==VoiceLatencyTrials.MAX_RECORDS&&trials.dropped()>0,"the record buffer is bounded");
  trials.clear();
  check(trials.snapshot().isEmpty()&&trials.pending()==null&&trials.dropped()==0,"clear");
  VoiceLatencyTrials owned=new VoiceLatencyTrials(()->0L);
  VoiceLatencyTrials.Trial old=owned.speechEnded(0,MS,"audiorecord-timestamp","live-voice");
  VoiceLatencyTrials.Trial newer=owned.speechEnded(2*MS,3*MS,"audiorecord-timestamp","live-voice");
  check(!owned.mark(old,"tts-start",4*MS),"delayed queued synthesis cannot stamp a newer turn");
  owned.engineLoaded(old,"stale-load");
  check(!newer.coldReason.contains("stale-load"),"stale engine load cannot change new turn");
  check(owned.firstPcm(old,5*MS)==null,"old prepared playback cannot attach to a newer turn");
  check(owned.mark(newer,"tts-start",6*MS),"current stage accepted");
  check(!owned.mark(newer,"tts-ready",5*MS),"stage time cannot precede its predecessor");
  check(owned.firstPcm(newer,5*MS)==null,"playback cannot precede a known stage");
  owned.clear();check(owned.firstPcm(newer,7*MS)==null,"cleared trial cannot resume");
  // Renderer stages (bridge-stamped) and the turn id that links every stage of one turn.
  check(VoiceLatencyTrials.rendererStage("asr-final")&&VoiceLatencyTrials.rendererStage("request")&&VoiceLatencyTrials.rendererStage("first-token"),"renderer stages");
  check(!VoiceLatencyTrials.rendererStage("first-pcm")&&!VoiceLatencyTrials.rendererStage("tts-start")&&!VoiceLatencyTrials.rendererStage("endpoint"),"native-only marks are not renderer stages");
  VoiceLatencyTrials linked=new VoiceLatencyTrials(()->0L);
  VoiceLatencyTrials.Trial turn=linked.speechEnded(0,MS,"audiorecord-timestamp","live-voice");
  check(turn.turnId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),"a random turn id");
  check(linked.forTurn(turn.turnId)==turn&&linked.forTurn("00000000-0000-4000-8000-000000000000")==null&&linked.forTurn(null)==null,"only the open turn's id binds");
  check(linked.mark(turn,"asr-final",2*MS)&&linked.mark(turn,"request",3*MS)&&linked.mark(turn,"first-token",4*MS)&&linked.mark(turn,"tts-start",5*MS)&&linked.mark(turn,"tts-ready",6*MS),"capture to synthesis stages in order");
  check(!linked.mark(turn,"first-token",4*MS),"each stage once");
  check(linked.firstPcm(turn,7*MS)==turn&&linked.audible(turn,8*MS,"audiotrack-timestamp")&&"passed".equals(turn.outcome),"one linked trial from capture to audible playback");
  check(turn.marks[VoiceLatencyTrials.index("request")]==3*MS&&turn.marks[VoiceLatencyTrials.index("first-token")]==4*MS,"request and first-token are kept");
  check(linked.forTurn(turn.turnId)==null,"a finished turn no longer binds");
  VoiceLatencyTrials.Trial order=linked.speechEnded(10*MS,11*MS,"audiorecord-timestamp","live-voice");
  check(linked.mark(order,"request",13*MS)&&!linked.mark(order,"asr-final",14*MS)&&!linked.mark(order,"first-token",12*MS),"stages cannot run backwards");
  VoiceLatencyTrials.Trial later=linked.speechEnded(20*MS,21*MS,"audiorecord-timestamp","live-voice");
  check(linked.forTurn(order.turnId)==null&&!order.turnId.equals(later.turnId),"a superseded turn's id no longer binds");
  linked.stopped(later);check(linked.pending()==later,"a stop before first-pcm leaves the turn open (barge-in during synthesis)");
  linked.mark(later,"tts-start",22*MS);linked.firstPcm(later,23*MS);linked.stopped(later);
  check("failed".equals(later.outcome)&&"playback-stopped".equals(later.reason),"a stop after first-pcm fails the trial");
  System.out.println("PASS voice latency trials");
 }
}

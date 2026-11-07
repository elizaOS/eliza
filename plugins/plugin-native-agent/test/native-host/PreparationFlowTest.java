package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
public final class PreparationFlowTest {
 static int assertions;
 static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
 interface Operation{void run()throws Exception;}
 static void rejects(Operation op)throws Exception{try{op.run();throw new AssertionError("Expected rejection");}catch(IOException expected){assertions++;}}
 static final UpdateJournal.Identity BASE=new UpdateJournal.Identity(1,"a".repeat(64));
 static PreparationFlow.Fence idle(String channel,long generation,UpdateJournal.Identity installed){return new PreparationFlow.Fence(channel,generation,installed,UpdateJournal.Phase.IDLE,null);}
 static PreparationFlow.Fence at(UpdateJournal.Phase phase){return new PreparationFlow.Fence("stable",0,BASE,phase,"plan");}
 static final class Fake implements PreparationFlow.Ports {
  final List<String> calls=new ArrayList<>();final JobRunRegistry.Cancellation cancellation=new JobRunRegistry.Cancellation();
  PreparationFlow.Fence current=idle("stable",0,BASE);
  String cancelAt="",changeAt="",failAt="",commitDecision="eligible",recoveryDecision="loadable";boolean defer,stageDeferred;
  void step(String name)throws Exception{calls.add(name);if(name.equals(cancelAt))cancellation.cancel();if(name.equals(changeAt))current=idle("beta",1,BASE);if(name.equals(failAt))throw new IOException("injected "+name);}
  public PreparationFlow.Fence capture(){return current;}
  public void prune()throws Exception{step("prune");}
  public PreparationFlow.Prepared discover(PreparationFlow.Fence f)throws Exception{step("discover");return defer?null:new PreparationFlow.Prepared(){};}
  public PreparationFlow.Staged stage(PreparationFlow.Prepared p,PreparationFlow.Fence f)throws Exception{step("stage");return stageDeferred?null:new PreparationFlow.Staged(){};}
  public void verify(PreparationFlow.Staged p,PreparationFlow.Fence f)throws Exception{step("verify");}
  public void admit(PreparationFlow.Staged p,PreparationFlow.Fence f,JobRunRegistry.Cancellation cancellation)throws Exception{PreparationFlow.check(cancellation);step("admit");}
  public void refresh(PreparationFlow.Fence f)throws Exception{step("refresh");}
  public String commitDecision(PreparationFlow.Fence f)throws Exception{step("commitDecision");return commitDecision;}
  public void discardVerified(PreparationFlow.Fence f,String reason)throws Exception{step("discardVerified:"+reason);current=idle("stable",0,BASE);}
  public String recoveryDecision(PreparationFlow.Fence f)throws Exception{step("recoveryDecision");return recoveryDecision;}
  public void recoveryUnavailable(PreparationFlow.Fence f,String reason)throws Exception{step("recoveryUnavailable:"+reason);current=at(UpdateJournal.Phase.QUARANTINED);}
  PreparationFlow.Outcome run()throws Exception{return PreparationFlow.run(this,cancellation);}
 }
 public static void main(String[] args)throws Exception {
  Fake happy=new Fake();check(happy.run()==PreparationFlow.Outcome.PREPARED);check(happy.calls.equals(List.of("prune","discover","stage","verify","admit")));
  Fake busy=new Fake();busy.current=at(UpdateJournal.Phase.COMMITTING);check(busy.run()==PreparationFlow.Outcome.BUSY);check(busy.calls.isEmpty());
  Fake stopped=new Fake();stopped.cancellation.cancel();rejects(stopped::run);check(stopped.calls.isEmpty());
  Fake deferred=new Fake();deferred.defer=true;check(deferred.run()==PreparationFlow.Outcome.DEFERRED);check(deferred.calls.equals(List.of("prune","discover")));
  Fake delayed=new Fake();delayed.stageDeferred=true;check(delayed.run()==PreparationFlow.Outcome.DEFERRED);check(delayed.calls.equals(List.of("prune","discover","stage")));
  for(String phase:List.of("prune","discover","stage","verify")) {
   Fake cancelled=new Fake();cancelled.cancelAt=phase;rejects(cancelled::run);check(!cancelled.calls.contains("admit"));check(cancelled.calls.get(cancelled.calls.size()-1).equals(phase));
   Fake changed=new Fake();changed.changeAt=phase;rejects(changed::run);check(!changed.calls.contains("admit"));
   Fake failed=new Fake();failed.failAt=phase;rejects(failed::run);check(!failed.calls.contains("admit"));
  }
  // Discovery waits while a plan is admitted or an install or recovery runs.
  for(UpdateJournal.Phase phase:UpdateJournal.Phase.values())
   check(PreparationFlow.busy(phase)==!EnumSet.of(UpdateJournal.Phase.IDLE,UpdateJournal.Phase.STAGING,UpdateJournal.Phase.HEALTHY,UpdateJournal.Phase.RECOVERED,UpdateJournal.Phase.QUARANTINED).contains(phase));
  // A VERIFIED plan is refreshed, never prepared again, and dropped only for good reasons.
  Fake fresh=new Fake();fresh.current=at(UpdateJournal.Phase.VERIFIED);check(fresh.run()==PreparationFlow.Outcome.REFRESHED);check(fresh.calls.equals(List.of("refresh","commitDecision")));
  for(String reason:List.of("expired","revoked-artifact","below-security-floor","superseded")) {
   Fake revoked=new Fake();revoked.current=at(UpdateJournal.Phase.VERIFIED);revoked.commitDecision=reason;
   check(revoked.run()==PreparationFlow.Outcome.DISCARDED);check(revoked.calls.equals(List.of("refresh","commitDecision","discardVerified:"+reason)));
  }
  for(String reason:List.of("stale-metadata","rollout-time")) {
   Fake waiting=new Fake();waiting.current=at(UpdateJournal.Phase.VERIFIED);waiting.commitDecision=reason;
   check(waiting.run()==PreparationFlow.Outcome.REFRESHED);check(waiting.calls.equals(List.of("refresh","commitDecision")));
  }
  for(String phase:List.of("refresh","commitDecision")) {
   Fake broken=new Fake();broken.current=at(UpdateJournal.Phase.VERIFIED);broken.commitDecision="revoked-artifact";broken.failAt=phase;rejects(broken::run);check(broken.calls.stream().noneMatch(c->c.startsWith("discardVerified")));
   Fake halted=new Fake();halted.current=at(UpdateJournal.Phase.VERIFIED);halted.commitDecision="revoked-artifact";halted.cancelAt=phase;rejects(halted::run);check(halted.calls.stream().noneMatch(c->c.startsWith("discardVerified")));
  }
  // RECOVERY_READY waits for a recovery that can load, and gives way to
  // discovery once revocations or floors rule it out for good.
  Fake recovery=new Fake();recovery.current=at(UpdateJournal.Phase.RECOVERY_READY);check(recovery.run()==PreparationFlow.Outcome.BUSY);check(recovery.calls.equals(List.of("recoveryDecision")));
  for(String reason:List.of("revoked-artifact","below-security-floor")) {
   Fake forward=new Fake();forward.current=at(UpdateJournal.Phase.RECOVERY_READY);forward.recoveryDecision=reason;
   check(forward.run()==PreparationFlow.Outcome.PREPARED);check(forward.calls.equals(List.of("recoveryDecision","recoveryUnavailable:"+reason,"prune","discover","stage","verify","admit")));
  }
  Fake unknown=new Fake();unknown.current=at(UpdateJournal.Phase.RECOVERY_READY);unknown.recoveryDecision="error";check(unknown.run()==PreparationFlow.Outcome.BUSY);check(unknown.calls.equals(List.of("recoveryDecision")));
  // Lost prepared or admission state is an error, not a decision: the wait
  // continues and nothing is quarantined until an owner decision says otherwise.
  Fake lost=new Fake();lost.current=at(UpdateJournal.Phase.RECOVERY_READY);lost.failAt="recoveryDecision";rejects(lost::run);check(lost.calls.equals(List.of("recoveryDecision")));
  // A commit refreshes no earlier than its run began and commits within the run bound.
  CommitFreshness run=CommitFreshness.forActivation(5_000);
  check(run.refreshedAfterLowerMs==5_000&&run.commitByUpperMs==605_000);
  check(CommitFreshness.forActivation(1).refreshedAfterLowerMs==1&&CommitFreshness.UNBOUNDED.refreshedAfterLowerMs==0&&CommitFreshness.UNBOUNDED.commitByUpperMs==0);
  for(long start:new long[]{0,-1,QualifiedClockAnchor.MAX})
   try{CommitFreshness.forActivation(start);throw new AssertionError("Bad activation start accepted");}catch(IllegalArgumentException expected){assertions++;}
  PreparationFlow.Fence original=idle("stable",0,BASE);
  check(!original.matches(idle("stable",1,BASE)));
  check(!original.matches(idle("stable",0,new UpdateJournal.Identity(2,"b".repeat(64)))));
  check(!original.matches(at(UpdateJournal.Phase.COMMITTING)));
  AtomicInteger first=new AtomicInteger(),second=new AtomicInteger();PreparationFlow.Resources resources=new PreparationFlow.Resources();
  resources.attach(first::incrementAndGet);resources.release();check(first.get()==1);
  resources.attach(second::incrementAndGet);resources.close();resources.release();check(second.get()==1);
  AtomicInteger late=new AtomicInteger();rejects(()->resources.attach(late::incrementAndGet));check(late.get()==1);resources.close();check(second.get()==1);
  for(int i=0;i<100;i++){
   PreparationFlow.Resources race=new PreparationFlow.Resources();AtomicInteger closed=new AtomicInteger();
   Thread cancel=new Thread(race::close);cancel.start();try{race.attach(closed::incrementAndGet);}catch(IOException expected){}cancel.join();race.release();check(closed.get()==1);
  }
  System.out.println("PreparationFlow: "+assertions+" assertions passed");
 }
}

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
 static final class Fake implements PreparationFlow.Ports {
  final List<String> calls=new ArrayList<>();final JobRunRegistry.Cancellation cancellation=new JobRunRegistry.Cancellation();
  PreparationFlow.Fence current=new PreparationFlow.Fence("stable",0,BASE,false);
  String cancelAt="",changeAt="",failAt="";boolean defer,stageDeferred;
  void step(String name)throws Exception{calls.add(name);if(name.equals(cancelAt))cancellation.cancel();if(name.equals(changeAt))current=new PreparationFlow.Fence("beta",1,BASE,false);if(name.equals(failAt))throw new IOException("injected "+name);}
  public PreparationFlow.Fence capture(){return current;}
  public void prune()throws Exception{step("prune");}
  public PreparationFlow.Prepared discover(PreparationFlow.Fence f)throws Exception{step("discover");return defer?null:new PreparationFlow.Prepared(){};}
  public PreparationFlow.Staged stage(PreparationFlow.Prepared p,PreparationFlow.Fence f)throws Exception{step("stage");return stageDeferred?null:new PreparationFlow.Staged(){};}
  public void verify(PreparationFlow.Staged p,PreparationFlow.Fence f)throws Exception{step("verify");}
  public void admit(PreparationFlow.Staged p,PreparationFlow.Fence f,JobRunRegistry.Cancellation cancellation)throws Exception{PreparationFlow.check(cancellation);step("admit");}
  PreparationFlow.Outcome run()throws Exception{return PreparationFlow.run(this,cancellation);}
 }
 public static void main(String[] args)throws Exception {
  Fake happy=new Fake();check(happy.run()==PreparationFlow.Outcome.PREPARED);check(happy.calls.equals(List.of("prune","discover","stage","verify","admit")));
  Fake busy=new Fake();busy.current=new PreparationFlow.Fence("stable",0,BASE,true);check(busy.run()==PreparationFlow.Outcome.BUSY);check(busy.calls.isEmpty());
  Fake stopped=new Fake();stopped.cancellation.cancel();rejects(stopped::run);check(stopped.calls.isEmpty());
  Fake deferred=new Fake();deferred.defer=true;check(deferred.run()==PreparationFlow.Outcome.DEFERRED);check(deferred.calls.equals(List.of("prune","discover")));
  Fake delayed=new Fake();delayed.stageDeferred=true;check(delayed.run()==PreparationFlow.Outcome.DEFERRED);check(delayed.calls.equals(List.of("prune","discover","stage")));
  for(String phase:List.of("prune","discover","stage","verify")) {
   Fake cancelled=new Fake();cancelled.cancelAt=phase;rejects(cancelled::run);check(!cancelled.calls.contains("admit"));check(cancelled.calls.get(cancelled.calls.size()-1).equals(phase));
   Fake changed=new Fake();changed.changeAt=phase;rejects(changed::run);check(!changed.calls.contains("admit"));
   Fake failed=new Fake();failed.failAt=phase;rejects(failed::run);check(!failed.calls.contains("admit"));
  }
  PreparationFlow.Fence original=new PreparationFlow.Fence("stable",0,BASE,false);
  check(!original.matches(new PreparationFlow.Fence("stable",1,BASE,false)));
  check(!original.matches(new PreparationFlow.Fence("stable",0,new UpdateJournal.Identity(2,"b".repeat(64)),false)));
  check(!original.matches(new PreparationFlow.Fence("stable",0,BASE,true)));
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

package ai.eliza.plugins.agent.updater;
import java.io.*;import java.nio.channels.FileChannel;import java.nio.file.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
import static ai.eliza.plugins.agent.updater.UpdateJournal.*;
public final class ProbationWindowTest {
 static int assertions;
 static final Durability SYNC=p->{try(FileChannel f=FileChannel.open(p,StandardOpenOption.READ)){f.force(true);}};
 static final Identity BASE=new Identity(1,"a".repeat(64)),CANDIDATE=new Identity(2,"b".repeat(64)),RECOVERY=new Identity(3,"c".repeat(64));
 static final Plan PLAN=new Plan("probation","stable","launcher",BASE,CANDIDATE,RECOVERY);
 static final ProbationPolicy POLICY=new ProbationPolicy("d".repeat(64),300,200,100);
 static final String PROCESS="12345678-1234-4567-89ab-123456789abc",RUNTIME="22345678-1234-4567-89ab-123456789abc",OTHER="32345678-1234-4567-89ab-123456789abc";
 interface Work{void run()throws Exception;}
 static void check(boolean v){assertions++;if(!v)throw new AssertionError("Assertion "+assertions);}
 static void rejects(Work w)throws Exception{try{w.run();throw new AssertionError("Expected IOException");}catch(IOException expected){assertions++;}}
 static ProbationSample sample(long boot,long elapsed,ProbationKind kind){return new ProbationSample(boot,elapsed,PROCESS,RUNTIME,kind);}
 static UpdateJournal create(Path directory)throws Exception{UpdateJournal j=new UpdateJournal(directory,SYNC);j.begin(PLAN,BASE,0);j.committing(PLAN.id,4,0);j.reconcile(CANDIDATE,false);return j;}
 static Snapshot record(UpdateJournal j,long boot,long time,ProbationKind kind)throws Exception{return j.observeProbation(j.read(),CANDIDATE,POLICY,sample(boot,time,kind));}
 public static void main(String[] args)throws Exception {
  Path root=Path.of(args[0]);Files.createDirectories(root);
  if(args.length==2){UpdateJournal j=new UpdateJournal(root,SYNC,n->{if(n.equals(args[1]))Runtime.getRuntime().halt(24);});record(j,1,200,ProbationKind.READY);throw new AssertionError();}
  UpdateJournal j=create(root.resolve("continuity"));
  check(record(j,1,100,ProbationKind.READY).probation.readyMillis==0);
  check(record(j,1,200,ProbationKind.READY).probation.readyMillis==100);
  j=new UpdateJournal(root.resolve("continuity"),SYNC);
  check(j.read().probation.readyMillis==100);
  check(record(j,1,300,ProbationKind.READY).probation.readyMillis==200);
  Snapshot ready=record(j,1,400,ProbationKind.READY);check(ready.probation.readyDurationReached());check(!ready.probation.failureDurationReached());check(ready.phase==Phase.PROBATION);check(ready.quarantine.isEmpty());
  check(record(j,1,500,ProbationKind.READY).probation.readyMillis==300);
  Snapshot unknown=record(j,1,600,ProbationKind.UNKNOWN);check(unknown.probation.readyMillis==0);check(!unknown.probation.readyDurationReached());
  check(record(j,1,700,ProbationKind.LOCAL_FAILURE).probation.failureMillis==0);
  check(record(j,1,800,ProbationKind.LOCAL_FAILURE).probation.failureMillis==100);
  Snapshot failed=record(j,1,900,ProbationKind.LOCAL_FAILURE);check(failed.probation.failureDurationReached());check(failed.phase==Phase.PROBATION);check(failed.quarantine.isEmpty());
  check(record(j,1,1000,ProbationKind.READY).probation.failureMillis==0);
  record(j,1,1100,ProbationKind.READY);check(record(j,1,1200,ProbationKind.PAUSED).probation.readyMillis==100);
  check(record(j,1,100000,ProbationKind.PAUSED).probation.readyMillis==100);
  check(record(j,1,200000,ProbationKind.READY).probation.readyMillis==100);
  check(record(j,1,200100,ProbationKind.READY).probation.readyMillis==200);
  check(record(j,1,200201,ProbationKind.PAUSED).probation.readyMillis==0); // cannot retroactively classify an unobserved gap
  record(j,1,200300,ProbationKind.READY);record(j,1,200400,ProbationKind.READY);
  check(record(j,1,200501,ProbationKind.READY).probation.readyMillis==0);
  record(j,1,200601,ProbationKind.READY);
  check(j.observeProbation(j.read(),CANDIDATE,POLICY,new ProbationSample(1,200701,PROCESS,OTHER,ProbationKind.READY)).probation.readyMillis==0);
  check(j.observeProbation(j.read(),CANDIDATE,POLICY,new ProbationSample(1,200801,OTHER,OTHER,ProbationKind.READY)).probation.readyMillis==0);
  check(record(j,2,1,ProbationKind.READY).probation.readyMillis==0);
  final UpdateJournal clock=j;byte[] before=Files.readAllBytes(root.resolve("continuity/journal"));
  rejects(()->record(clock,1,Long.MAX_VALUE,ProbationKind.READY));rejects(()->record(clock,2,1,ProbationKind.READY));rejects(()->record(clock,2,0,ProbationKind.READY));
  check(java.util.Arrays.equals(before,Files.readAllBytes(root.resolve("continuity/journal"))));
  record(j,2,101,ProbationKind.READY);
  ProbationPolicy changed=new ProbationPolicy(POLICY.id,400,200,100);
  check(j.observeProbation(j.read(),CANDIDATE,changed,sample(2,201,ProbationKind.READY)).probation.readyMillis==0);
  Snapshot stale=j.read();j.setChannel("beta");check(j.read().probation==null);
  rejects(()->clock.observeProbation(stale,CANDIDATE,POLICY,sample(2,301,ProbationKind.READY)));
  rejects(()->clock.observeProbation(clock.read(),BASE,POLICY,sample(2,301,ProbationKind.READY)));
  record(j,2,301,ProbationKind.READY);j.localHealthFailed(j.read(),CANDIDATE);check(j.read().probation==null);j.recovering(PLAN.id,5);j.reconcile(RECOVERY,false);
  rejects(()->record(clock,2,401,ProbationKind.READY));
  check(j.observeProbation(j.read(),RECOVERY,POLICY,sample(2,401,ProbationKind.READY)).probation.readyMillis==0);
  check(j.read().phase==Phase.RECOVERY_PROBATION);
  UpdateJournal race=create(root.resolve("race"));Snapshot observed=race.read();CountDownLatch start=new CountDownLatch(1);AtomicInteger accepted=new AtomicInteger(),denied=new AtomicInteger();AtomicReference<Throwable> error=new AtomicReference<>();
  Runnable work=()->{try{start.await();race.observeProbation(observed,CANDIDATE,POLICY,sample(1,100,ProbationKind.READY));accepted.incrementAndGet();}catch(IOException expected){denied.incrementAndGet();}catch(Throwable t){error.set(t);}};
  Thread a=new Thread(work),b=new Thread(work);a.start();b.start();start.countDown();a.join();b.join();check(error.get()==null);check(accepted.get()==1);check(denied.get()==1);check(race.read().probation.readyMillis==0);
  for(String boundary:new String[]{"before-sync","before-rename","published"}){
   Path dir=root.resolve("kill-"+boundary);UpdateJournal crash=create(dir);record(crash,1,100,ProbationKind.READY);
   Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),ProbationWindowTest.class.getName(),dir.toString(),boundary).inheritIO().start();check(child.waitFor()==24);
   crash=new UpdateJournal(dir,SYNC);check(crash.read().phase==Phase.PROBATION);check(crash.read().probation.readyMillis==(boundary.equals("published")?100:0));
   check(record(crash,1,300,ProbationKind.READY).probation.readyMillis==(boundary.equals("published")?200:0));check(!crash.read().probation.readyDurationReached());
  }
  System.out.println("ProbationWindow: "+assertions+" assertions passed; 3 real process-death boundaries");
 }
}

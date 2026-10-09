package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
public final class UpdateJournalTest {
  static int assertions;
  static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
  interface Operation{void run()throws Exception;}
  static void rejects(Operation op)throws Exception{try{op.run();throw new AssertionError("Expected rejection");}catch(IOException expected){assertions++;}}
  static final UpdateJournal.Durability SYNC=p->{try(FileChannel f=FileChannel.open(p,StandardOpenOption.READ)){f.force(true);}};
  static UpdateJournal.Identity id(long code,char c){char[] bytes=new char[64];Arrays.fill(bytes,c);return new UpdateJournal.Identity(code,new String(bytes));}
  static final UpdateJournal.Identity OLD=id(10,'a'), NEW=id(11,'b'), RECOVERY=id(12,'c');
  static UpdateJournal.Plan plan(String channel){return new UpdateJournal.Plan("release-11",channel,"launcher",OLD,NEW,RECOVERY);}
  public static void main(String[] args)throws Exception{
    Path directory=Path.of(args[0]);Files.createDirectories(directory);
    if(args.length==3){UpdateJournal journal=new UpdateJournal(directory,SYNC,name->{if(name.equals(args[1]))Runtime.getRuntime().halt(24);});if(args[2].equals("stage"))journal.stageValidated(plan("stable"),OLD,0,()->{});else journal.observePending("release-11",4,10,600,1000);throw new AssertionError();}
    if(args.length==2){UpdateJournal journal=new UpdateJournal(directory,SYNC,name->{if(name.equals(args[1]))Runtime.getRuntime().halt(24);});journal.setChannel("beta");throw new AssertionError();}
    UpdateJournal fenced=new UpdateJournal(directory.resolve("health-fence"),SYNC);
    fenced.begin(plan("stable"),OLD,0);fenced.committing("release-11",1,0);fenced.reconcile(NEW,false);
    UpdateJournal.Snapshot observation=fenced.read();
    fenced.setChannel("beta");
    rejects(()->fenced.installedHealthy(observation,NEW));
    rejects(()->fenced.localHealthFailed(observation,NEW));
    check(fenced.read().phase==UpdateJournal.Phase.PROBATION);check(fenced.read().quarantine.isEmpty());
    UpdateJournal.Snapshot fresh=fenced.read();
    fenced.installedHealthy(fresh,NEW);
    rejects(()->fenced.localHealthFailed(fresh,NEW));
    rejects(()->fenced.installedHealthy(fresh,NEW));
    check(fenced.read().phase==UpdateJournal.Phase.HEALTHY);
    rejects(()->fenced.localHealthFailed(null,NEW));
    UpdateJournal race=new UpdateJournal(directory.resolve("health-race"),SYNC);
    race.begin(plan("stable"),OLD,0);race.committing("release-11",1,0);race.reconcile(NEW,false);
    UpdateJournal.Snapshot shared=race.read();
    java.util.concurrent.CountDownLatch start=new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicInteger accepted=new java.util.concurrent.atomic.AtomicInteger(),denied=new java.util.concurrent.atomic.AtomicInteger();
    java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();
    Thread good=new Thread(()->{try{start.await();race.installedHealthy(shared,NEW);accepted.incrementAndGet();}catch(IOException expected){denied.incrementAndGet();}catch(Throwable error){failure.set(error);}});
    Thread bad=new Thread(()->{try{start.await();race.localHealthFailed(shared,NEW);accepted.incrementAndGet();}catch(IOException expected){denied.incrementAndGet();}catch(Throwable error){failure.set(error);}});
    good.start();bad.start();start.countDown();good.join();bad.join();
    check(failure.get()==null);check(accepted.get()==1);check(denied.get()==1);check(race.read().revision==shared.revision+1);
    UpdateJournal queue=new UpdateJournal(directory.resolve("staging"),SYNC);
    queue.stageValidated(plan("stable"),OLD,0,()->{});check(queue.read().phase==UpdateJournal.Phase.STAGING);
    check(new UpdateJournal(directory.resolve("staging"),SYNC).read().plan.id.equals("release-11"));
    rejects(()->queue.committing("release-11",4,0));rejects(()->queue.stageValidated(plan("stable"),OLD,0,()->{}));
    UpdateJournal.Plan replacement=new UpdateJournal.Plan("release-11","stable","launcher",OLD,id(13,'d'),id(14,'e'));
    rejects(()->queue.beginValidated(replacement,OLD,0,()->{}));
    rejects(()->queue.beginValidated(plan("stable"),OLD,0,()->{throw new IOException("lost authorization");}));check(queue.read().phase==UpdateJournal.Phase.STAGING);
    rejects(()->queue.discardStaging("release-11",1));rejects(()->queue.discardStaging("other",0));
    queue.setChannel("beta");check(queue.read().phase==UpdateJournal.Phase.IDLE);check(queue.read().plan==null);
    rejects(()->queue.begin(plan("stable"),OLD,0));
    queue.stageValidated(plan("beta"),OLD,1,()->{});queue.beginValidated(plan("beta"),OLD,1,()->{});check(queue.read().phase==UpdateJournal.Phase.VERIFIED);
    rejects(()->queue.discardStaging("release-11",1));
    UpdateJournal discard=new UpdateJournal(directory.resolve("discard-stage"),SYNC);discard.stageValidated(plan("stable"),OLD,0,()->{});discard.discardStaging("release-11",0);check(discard.read().phase==UpdateJournal.Phase.IDLE);check(discard.read().plan==null);
    for(String boundary:new String[]{"before-sync","before-rename","published"}){
      Path root=directory.resolve("stage-"+boundary);new UpdateJournal(root,SYNC).setChannel("stable");
      Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),UpdateJournalTest.class.getName(),root.toString(),boundary,"stage").inheritIO().start();check(child.waitFor()==24);
      UpdateJournal resumed=new UpdateJournal(root,SYNC);check(resumed.read().phase==(boundary.equals("published")?UpdateJournal.Phase.STAGING:UpdateJournal.Phase.IDLE));
      if(resumed.read().phase==UpdateJournal.Phase.IDLE)resumed.stageValidated(plan("stable"),OLD,0,()->{});
      resumed.beginValidated(plan("stable"),OLD,0,()->{});check(resumed.read().phase==UpdateJournal.Phase.VERIFIED);
    }
    UpdateJournal timer=new UpdateJournal(directory.resolve("timer"),SYNC);
    timer.begin(plan("stable"),OLD,0);timer.committing("release-11",4,0);
    timer.observePending("wrong",4,10,100,1000);check(timer.read().pendingMillis==0);
    timer.observePending("release-11",5,10,100,1000);check(timer.read().pendingMillis==0);
    timer.observePending("release-11",4,10,100,1000);
    timer.observePending("release-11",4,10,600,1000);check(timer.read().pendingMillis==500);
    timer=new UpdateJournal(directory.resolve("timer"),SYNC);
    timer.observePending("release-11",4,11,5,1000);check(timer.read().pendingMillis==505);
    timer.observePending("release-11",4,11,499,1000);check(timer.read().phase==UpdateJournal.Phase.COMMITTING);
    timer.observePending("release-11",4,11,500,1000);check(timer.read().reason.equals("install_timeout"));
    check(timer.read().pendingMillis==1000);check(timer.read().quarantine.isEmpty());
    timer.setChannel("beta");check(timer.read().reason.equals("install_timeout"));
    check(UpdateJournal.awaitingInstaller(timer.read()));
    timer.reconcile("release-11",4,NEW,true);check(timer.read().phase==UpdateJournal.Phase.PROBATION);
    timer.localHealthFailed(timer.read(),NEW);timer.recovering("release-11",5);check(timer.read().pendingMillis==0);
    timer.observePending("release-11",5,11,505,1000);timer.observePending("release-11",5,11,1505,1000);
    check(timer.read().reason.equals("install_timeout"));
    timer.reconcile("release-11",5,RECOVERY,false);check(timer.read().phase==UpdateJournal.Phase.RECOVERY_PROBATION);
    for(boolean bootRegression:new boolean[]{false,true}) {
      UpdateJournal clock=new UpdateJournal(directory.resolve("clock-"+bootRegression),SYNC);
      clock.begin(plan("stable"),OLD,0);clock.committing("release-11",4,0);clock.observePending("release-11",4,10,100,1000);
      rejects(()->clock.observePending("release-11",4,-1,200,1000));
      clock.observePending("release-11",4,bootRegression?9:10,99,1000);
      check(clock.read().reason.equals("install_clock_invalid"));check(UpdateJournal.awaitingInstaller(clock.read()));
      clock.reconcile("release-11",4,NEW,false);check(clock.read().phase==UpdateJournal.Phase.PROBATION);
    }
    UpdateJournal rebootLoop=new UpdateJournal(directory.resolve("reboot-loop"),SYNC);
    rebootLoop.begin(plan("stable"),OLD,0);rebootLoop.committing("release-11",4,0);rebootLoop.observePending("release-11",4,10,100,1000);
    for(int boot=11;boot<=14;boot++)rebootLoop.observePending("release-11",4,boot,250,1000);
    check(rebootLoop.read().reason.equals("install_timeout"));check(rebootLoop.read().pendingMillis==1000);
    rebootLoop.reconcile("release-11",4,OLD,true);check(rebootLoop.read().reason.equals("install_timeout"));
    rejects(()->rebootLoop.begin(plan("stable"),OLD,0));
    // Independently encode historical formats; do not derive them by trimming
    // the current writer, which can hide a format migration regression.
    for(int version=1;version<=3;version++) {
      Path oldFormat=directory.resolve("format-v"+version);UpdateJournal format=new UpdateJournal(oldFormat,SYNC);
      ByteArrayOutputStream legacyBody=new ByteArrayOutputStream();
      try(DataOutputStream out=new DataOutputStream(legacyBody)) {
        out.writeInt(0x53434f54);out.writeInt(version);out.writeLong(7);out.writeLong(0);out.writeUTF("stable");out.writeUTF("COMMITTING");out.writeUTF("");out.writeInt(4);out.writeInt(0);
        out.writeBoolean(true);out.writeUTF("release-11");out.writeUTF("stable");out.writeUTF("launcher");
        for(UpdateJournal.Identity identity:new UpdateJournal.Identity[]{OLD,NEW,RECOVERY}){out.writeLong(identity.code);out.writeUTF(identity.digest);}
        out.writeInt(0);if(version>=2){out.writeLong(100);out.writeLong(10);out.writeLong(100);}
      }
      ByteArrayOutputStream legacyBytes=new ByteArrayOutputStream();byte[] body=legacyBody.toByteArray();legacyBytes.write(body);legacyBytes.write(java.security.MessageDigest.getInstance("SHA-256").digest(body));Files.write(oldFormat.resolve("journal"),legacyBytes.toByteArray());
      check(format.read().phase==UpdateJournal.Phase.COMMITTING);check(format.read().pendingMillis==(version==1?0:100));check(format.read().probation==null);
      format.observePending("release-11",4,10,200,1000);check(format.read().phase==UpdateJournal.Phase.COMMITTING);check(format.read().pendingMillis==(version==1?0:200));
      check(java.nio.ByteBuffer.wrap(Files.readAllBytes(oldFormat.resolve("journal"))).getInt(4)==4);
    }
    for(String boundary:new String[]{"before-sync","before-rename","published"}) {
      Path root=directory.resolve("timer-"+boundary);UpdateJournal death=new UpdateJournal(root,SYNC);
      death.begin(plan("stable"),OLD,0);death.committing("release-11",4,0);death.observePending("release-11",4,10,100,1000);
      Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),UpdateJournalTest.class.getName(),root.toString(),boundary,"clock").inheritIO().start();check(child.waitFor()==24);
      death=new UpdateJournal(root,SYNC);check(death.read().pendingMillis==(boundary.equals("published")?500:0));
      death.observePending("release-11",4,10,1100,1000);check(death.read().pendingMillis==1000);check(death.read().reason.equals("install_timeout"));
    }
    for(String reason:new String[]{"user_action_required","policy_blocked"}) {
      UpdateJournal callback=new UpdateJournal(directory.resolve("callback-"+reason),SYNC);
      callback.begin(plan("stable"),OLD,0);callback.committing("release-11",5,0);
      callback.reconcileInstallerResult("stale",5,NEW,false,reason);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      callback.reconcileInstallerResult("release-11",6,NEW,false,reason);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      // Failure/success/unknown callbacks cannot fabricate session disappearance.
      callback.reconcileInstallerResult("release-11",5,OLD,true,null);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      callback.reconcileInstallerResult("release-11",5,OLD,true,reason);
      check(callback.read().phase==UpdateJournal.Phase.SUPPORT);check(callback.read().reason.equals(reason));
      check(UpdateJournal.awaitingInstaller(callback.read()));
      callback=new UpdateJournal(directory.resolve("callback-"+reason),SYNC);
      callback.reconcile("release-11",5,OLD,false);check(callback.read().phase==UpdateJournal.Phase.SUPPORT);
      callback.reconcile("release-11",5,NEW,false);check(callback.read().phase==UpdateJournal.Phase.PROBATION);
      callback.reconcileInstallerResult("release-11",5,OLD,false,reason);check(callback.read().phase==UpdateJournal.Phase.PROBATION);
      callback.localHealthFailed(callback.read(),NEW);callback.recovering("release-11",6);
      callback.reconcileInstallerResult("release-11",6,NEW,true,reason);check(callback.read().phase==UpdateJournal.Phase.SUPPORT);
      callback.reconcile("release-11",6,RECOVERY,false);check(callback.read().phase==UpdateJournal.Phase.RECOVERY_PROBATION);
      callback.installedHealthy(callback.read(),RECOVERY);check(callback.read().phase==UpdateJournal.Phase.RECOVERED);
      UpdateJournal installedWins=new UpdateJournal(directory.resolve("installed-wins-"+reason),SYNC);
      installedWins.begin(plan("stable"),OLD,0);installedWins.committing("release-11",8,0);
      installedWins.reconcileInstallerResult("release-11",8,NEW,true,reason);check(installedWins.read().phase==UpdateJournal.Phase.PROBATION);
      UpdateJournal unexpected=new UpdateJournal(directory.resolve("unexpected-"+reason),SYNC);
      unexpected.begin(plan("stable"),OLD,0);unexpected.committing("release-11",8,0);
      unexpected.reconcileInstallerResult("release-11",8,RECOVERY,true,reason);
      check(unexpected.read().reason.equals("unexpected_installed_identity"));check(!UpdateJournal.awaitingInstaller(unexpected.read()));
    }
    UpdateJournal j=new UpdateJournal(directory.resolve("normal"),SYNC);
    check(j.read().channel.equals("stable"));rejects(()->j.begin(plan("beta"),OLD,0));
    j.begin(plan("stable"),OLD,0);j.setChannel("beta");check(j.read().phase==UpdateJournal.Phase.IDLE);
    rejects(()->j.committing("release-11",1,0));
    rejects(()->j.begin(plan("stable"),OLD,1));
    j.begin(plan("beta"),OLD,1);j.committing("release-11",42,1);j.setChannel("stable");
    check(new UpdateJournal(directory.resolve("normal"),SYNC).read().phase==UpdateJournal.Phase.COMMITTING);
    j.reconcile(OLD,true);check(j.read().phase==UpdateJournal.Phase.COMMITTING);
    j.reconcile("old-transaction",42,NEW,false);check(j.read().phase==UpdateJournal.Phase.COMMITTING);
    j.reconcile("release-11",41,NEW,false);check(j.read().phase==UpdateJournal.Phase.COMMITTING);
    rejects(()->j.installerBlocked("release-11",99,"user_action_required"));
    j.reconcile(NEW,false);check(j.read().phase==UpdateJournal.Phase.PROBATION);
    rejects(()->j.installedHealthy(j.read(),OLD));
    j.localHealthFailed(j.read(),NEW);check(j.read().quarantine.contains(NEW.digest));
    j.recovering("release-11",43);rejects(()->j.recovering("release-11",44));
    j.reconcile(RECOVERY,false);check(j.read().phase==UpdateJournal.Phase.RECOVERY_PROBATION);
    j.installedHealthy(j.read(),RECOVERY);check(j.read().phase==UpdateJournal.Phase.RECOVERED);
    rejects(()->j.begin(plan("stable"),OLD,2));
    j.setChannel("beta");j.setChannel("stable");check(j.read().quarantine.contains(NEW.digest));
    UpdateJournal fail=new UpdateJournal(directory.resolve("fail"),SYNC);fail.begin(plan("stable"),OLD,0);fail.committing("release-11",1,0);fail.reconcile(NEW,false);fail.localHealthFailed(fail.read(),NEW);fail.recovering("release-11",2);fail.reconcile(NEW,false);check(fail.read().phase==UpdateJournal.Phase.SUPPORT);rejects(()->fail.recovering("release-11",3));
    UpdateJournal badRecovery=new UpdateJournal(directory.resolve("bad-recovery"),SYNC);badRecovery.begin(plan("stable"),OLD,0);badRecovery.committing("release-11",1,0);badRecovery.reconcile(NEW,false);badRecovery.localHealthFailed(badRecovery.read(),NEW);badRecovery.recovering("release-11",2);badRecovery.reconcile(RECOVERY,false);badRecovery.localHealthFailed(badRecovery.read(),RECOVERY);check(badRecovery.read().phase==UpdateJournal.Phase.SUPPORT);
    check(badRecovery.read().quarantine.contains(RECOVERY.digest));check(!fail.read().quarantine.contains(RECOVERY.digest));
    badRecovery.setChannel("beta");badRecovery.setChannel("stable");check(badRecovery.read().quarantine.contains(RECOVERY.digest));
    UpdateJournal rejectedPair=new UpdateJournal(directory.resolve("rejected-pair"),SYNC);
    rejectedPair.begin(plan("stable"),OLD,0);rejectedPair.committing("release-11",1,0);rejectedPair.reconcile(OLD,false);
    UpdateJournal.Plan quarantinedRecovery=new UpdateJournal.Plan("release-13","stable","launcher",OLD,id(13,'d'),id(14,'b'));
    rejects(()->rejectedPair.begin(quarantinedRecovery,OLD,0));
    Path lost=directory.resolve("lost");UpdateJournal loss=new UpdateJournal(lost,SYNC);loss.setChannel("beta");Files.delete(lost.resolve("journal"));rejects(loss::read);rejects(()->loss.setChannel("stable"));
    java.util.concurrent.atomic.AtomicBoolean cleanupOnLostJournal=new java.util.concurrent.atomic.AtomicBoolean(false);
    rejects(()->loss.withLockedSnapshot(state->cleanupOnLostJournal.set(true)));check(!cleanupOnLostJournal.get());
    Path interrupted=directory.resolve("first-write");UpdateJournal firstWrite=new UpdateJournal(interrupted,SYNC,name->{if(name.equals("before-sync"))throw new IOException("simulated first-write failure");});
    rejects(()->firstWrite.setChannel("beta"));rejects(()->new UpdateJournal(interrupted,SYNC).read());
    Path legacy=directory.resolve("legacy");UpdateJournal previous=new UpdateJournal(legacy,SYNC);previous.setChannel("beta");Files.delete(legacy.resolve("initialized"));check(previous.read().channel.equals("beta"));check(Files.exists(legacy.resolve("initialized")));
    UpdateJournal retention=new UpdateJournal(directory.resolve("retention"),SYNC);
    java.util.concurrent.atomic.AtomicBoolean validated=new java.util.concurrent.atomic.AtomicBoolean(false);
    rejects(()->retention.beginValidated(plan("stable"),OLD,0,()->{throw new IOException("authorization was retired");}));
    check(retention.read().phase==UpdateJournal.Phase.IDLE);
    retention.beginValidated(plan("stable"),OLD,0,()->validated.set(true));check(validated.get());
    long revision=retention.read().revision;
    retention.withLockedSnapshot(state->{check(state.plan.id.equals("release-11"));});check(retention.read().revision==revision);
    java.util.concurrent.CountDownLatch inspecting=new java.util.concurrent.CountDownLatch(1),finishInspect=new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.ExecutorService retentionPool=java.util.concurrent.Executors.newFixedThreadPool(2);
    try {
      var inspect=retentionPool.submit(()->{try{retention.withLockedSnapshot(state->{inspecting.countDown();try{finishInspect.await();}catch(InterruptedException e){throw new IOException(e);}});}catch(IOException e){throw new RuntimeException(e);}});
      check(inspecting.await(2,java.util.concurrent.TimeUnit.SECONDS));
      var change=retentionPool.submit(()->{try{retention.setChannel("beta");}catch(IOException e){throw new RuntimeException(e);}});
      try{change.get(100,java.util.concurrent.TimeUnit.MILLISECONDS);throw new AssertionError("channel changed during retention");}catch(java.util.concurrent.TimeoutException expected){assertions++;}
      finishInspect.countDown();inspect.get();change.get();check(retention.read().plan==null);
    } finally {finishInspect.countDown();retentionPool.shutdownNow();}
    UpdateJournal handoff=new UpdateJournal(directory.resolve("handoff"),SYNC);handoff.begin(plan("stable"),OLD,0);
    java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1),changing=new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.ExecutorService handoffPool=java.util.concurrent.Executors.newFixedThreadPool(2);
    try {
      var committed=handoffPool.submit(()->{try{handoff.committingWithAction("release-11",7,0,()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}});}catch(IOException e){throw new RuntimeException(e);}});
      check(entered.await(2,java.util.concurrent.TimeUnit.SECONDS));
      var changed=handoffPool.submit(()->{changing.countDown();try{handoff.setChannel("beta");}catch(IOException e){throw new RuntimeException(e);}});
      check(changing.await(2,java.util.concurrent.TimeUnit.SECONDS));
      try {changed.get(100,java.util.concurrent.TimeUnit.MILLISECONDS);throw new AssertionError("Channel crossed pending platform handoff");}catch(java.util.concurrent.TimeoutException expected){assertions++;}
      release.countDown();committed.get();changed.get();check(handoff.read().phase==UpdateJournal.Phase.COMMITTING);check(handoff.read().channel.equals("beta"));
    } finally {release.countDown();handoffPool.shutdownNow();}
    UpdateJournal stale=new UpdateJournal(directory.resolve("stale-handoff"),SYNC);stale.begin(plan("stable"),OLD,0);stale.setChannel("beta");
    java.util.concurrent.atomic.AtomicBoolean called=new java.util.concurrent.atomic.AtomicBoolean();rejects(()->stale.committingWithAction("release-11",8,0,()->called.set(true)));check(!called.get());
    Path failedHandoff=directory.resolve("failed-handoff");new UpdateJournal(failedHandoff,SYNC).begin(plan("stable"),OLD,0);
    UpdateJournal failedWrite=new UpdateJournal(failedHandoff,SYNC,name->{if(name.equals("before-sync"))throw new IOException("persist failed");});
    rejects(()->failedWrite.committingWithAction("release-11",8,0,()->called.set(true)));check(!called.get());
    for(String boundary:new String[]{"before-sync","before-rename","published"}){
      Path root=directory.resolve(boundary);new UpdateJournal(root,SYNC).setChannel("stable");
      Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),UpdateJournalTest.class.getName(),root.toString(),boundary).inheritIO().start();check(child.waitFor()==24);
      UpdateJournal reopened=new UpdateJournal(root,SYNC);check(reopened.read().channel.equals(boundary.equals("published")?"beta":"stable"));reopened.setChannel("beta");check(reopened.read().channel.equals("beta"));
    }
    Path journal=directory.resolve("normal/journal");byte[] corrupt=Files.readAllBytes(journal);corrupt[15]^=1;Files.write(journal,corrupt);rejects(j::read);
    Path concurrent=directory.resolve("concurrent");new UpdateJournal(concurrent,SYNC);
    java.util.concurrent.ExecutorService pool=java.util.concurrent.Executors.newFixedThreadPool(4);
    try {
      java.util.List<java.util.concurrent.Future<?>> jobs=new ArrayList<>();
      for(int i=0;i<16;i++)jobs.add(pool.submit(()->{try{new UpdateJournal(concurrent,SYNC).setChannel("beta");}catch(IOException e){throw new RuntimeException(e);}}));
      for(java.util.concurrent.Future<?> job:jobs)job.get();
      check(new UpdateJournal(concurrent,SYNC).read().revision==16);
      check(new UpdateJournal(concurrent,SYNC).read().channelGeneration==1);
    } finally {pool.shutdownNow();}
    System.out.println("UpdateJournal: "+assertions+" assertions passed; 9 real process-death boundaries");
  }
}

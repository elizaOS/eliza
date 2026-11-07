package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
public final class UpdateJournalTest {
  /** A plan that is still fresh: these cases are about the install, not commit freshness. */
  static final UpdateJournal.FreshnessCheck FRESH=(plan,generation)->{};
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
    fenced.begin(plan("stable"),OLD,0);fenced.committingWithAction("release-11",1,0,FRESH,()->{});fenced.reconcile(NEW,false);
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
    race.begin(plan("stable"),OLD,0);race.committingWithAction("release-11",1,0,FRESH,()->{});race.reconcile(NEW,false);
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
    rejects(()->queue.committingWithAction("release-11",4,0,FRESH,()->{}));rejects(()->queue.stageValidated(plan("stable"),OLD,0,()->{}));
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
    timer.begin(plan("stable"),OLD,0);timer.committingWithAction("release-11",4,0,FRESH,()->{});
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
      clock.begin(plan("stable"),OLD,0);clock.committingWithAction("release-11",4,0,FRESH,()->{});clock.observePending("release-11",4,10,100,1000);
      rejects(()->clock.observePending("release-11",4,-1,200,1000));
      clock.observePending("release-11",4,bootRegression?9:10,99,1000);
      check(clock.read().reason.equals("install_clock_invalid"));check(UpdateJournal.awaitingInstaller(clock.read()));
      clock.reconcile("release-11",4,NEW,false);check(clock.read().phase==UpdateJournal.Phase.PROBATION);
    }
    UpdateJournal rebootLoop=new UpdateJournal(directory.resolve("reboot-loop"),SYNC);
    rebootLoop.begin(plan("stable"),OLD,0);rebootLoop.committingWithAction("release-11",4,0,FRESH,()->{});rebootLoop.observePending("release-11",4,10,100,1000);
    for(int boot=11;boot<=14;boot++)rebootLoop.observePending("release-11",4,boot,250,1000);
    check(rebootLoop.read().reason.equals("install_timeout"));check(rebootLoop.read().pendingMillis==1000);
    rebootLoop.reconcile("release-11",4,OLD,true);check(rebootLoop.read().reason.equals("install_timeout"));
    rejects(()->rebootLoop.begin(plan("stable"),OLD,0));
    // Independently encode historical formats; do not derive them by trimming
    // the current writer, which can hide a format migration regression.
    for(int version=1;version<=4;version++) {
      Path oldFormat=directory.resolve("format-v"+version);UpdateJournal format=new UpdateJournal(oldFormat,SYNC);
      ByteArrayOutputStream legacyBody=new ByteArrayOutputStream();
      try(DataOutputStream out=new DataOutputStream(legacyBody)) {
        out.writeInt(0x53434f54);out.writeInt(version);out.writeLong(7);out.writeLong(0);out.writeUTF("stable");out.writeUTF("COMMITTING");out.writeUTF("");out.writeInt(4);out.writeInt(0);
        out.writeBoolean(true);out.writeUTF("release-11");out.writeUTF("stable");out.writeUTF("launcher");
        for(UpdateJournal.Identity identity:new UpdateJournal.Identity[]{OLD,NEW,RECOVERY}){out.writeLong(identity.code);out.writeUTF(identity.digest);}
        out.writeInt(0);if(version>=2){out.writeLong(100);out.writeLong(10);out.writeLong(100);}
        if(version>=4)out.writeBoolean(false);
      }
      ByteArrayOutputStream legacyBytes=new ByteArrayOutputStream();byte[] body=legacyBody.toByteArray();legacyBytes.write(body);legacyBytes.write(java.security.MessageDigest.getInstance("SHA-256").digest(body));Files.write(oldFormat.resolve("journal"),legacyBytes.toByteArray());
      check(format.read().phase==UpdateJournal.Phase.COMMITTING);check(format.read().pendingMillis==(version==1?0:100));check(format.read().probation==null);
      format.observePending("release-11",4,10,200,1000);check(format.read().phase==UpdateJournal.Phase.COMMITTING);check(format.read().pendingMillis==(version==1?0:200));
      check(format.read().reportedFailure==null);check(format.read().releasedCandidate.isEmpty());check(format.read().releases==0);
      // With no install record the rewrite stays version 4, which an older
      // updater still reads; a record moves it to version 5, and back once cleared.
      check(java.nio.ByteBuffer.wrap(Files.readAllBytes(oldFormat.resolve("journal"))).getInt(4)==4);
      if(version==4) {
        format.reconcileInstallerResult("release-11",4,OLD,true,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED);
        check(java.nio.ByteBuffer.wrap(Files.readAllBytes(oldFormat.resolve("journal"))).getInt(4)==5);
        check(new UpdateJournal(oldFormat,SYNC).read().reportedFailure==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED);
        format.reconcileInstallerResult("release-11",4,NEW,false,null,null);
        check(format.read().phase==UpdateJournal.Phase.PROBATION&&format.read().reportedFailure==null);
        check(java.nio.ByteBuffer.wrap(Files.readAllBytes(oldFormat.resolve("journal"))).getInt(4)==4);
      }
    }
    for(String boundary:new String[]{"before-sync","before-rename","published"}) {
      Path root=directory.resolve("timer-"+boundary);UpdateJournal death=new UpdateJournal(root,SYNC);
      death.begin(plan("stable"),OLD,0);death.committingWithAction("release-11",4,0,FRESH,()->{});death.observePending("release-11",4,10,100,1000);
      Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),UpdateJournalTest.class.getName(),root.toString(),boundary,"clock").inheritIO().start();check(child.waitFor()==24);
      death=new UpdateJournal(root,SYNC);check(death.read().pendingMillis==(boundary.equals("published")?500:0));
      death.observePending("release-11",4,10,1100,1000);check(death.read().pendingMillis==1000);check(death.read().reason.equals("install_timeout"));
    }
    for(String reason:new String[]{"user_action_required","policy_blocked"}) {
      UpdateJournal callback=new UpdateJournal(directory.resolve("callback-"+reason),SYNC);
      callback.begin(plan("stable"),OLD,0);callback.committingWithAction("release-11",5,0,FRESH,()->{});
      callback.reconcileInstallerResult("stale",5,NEW,false,reason);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      callback.reconcileInstallerResult("release-11",6,NEW,false,reason);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      // Failure/success/unknown callbacks cannot fabricate session disappearance.
      callback.reconcileInstallerResult("release-11",5,OLD,true,null);check(callback.read().phase==UpdateJournal.Phase.COMMITTING);
      callback.reconcileInstallerResult("release-11",5,OLD,true,reason);
      check(callback.read().phase==UpdateJournal.Phase.SUPPORT);check(callback.read().reason.equals(reason));
      check(UpdateJournal.awaitingInstaller(callback.read()));
      callback=new UpdateJournal(directory.resolve("callback-"+reason),SYNC);
      callback.reconcile("release-11",5,OLD,true);check(callback.read().phase==UpdateJournal.Phase.SUPPORT);
      callback.reconcile("release-11",5,NEW,false);check(callback.read().phase==UpdateJournal.Phase.PROBATION);
      callback.reconcileInstallerResult("release-11",5,OLD,false,reason);check(callback.read().phase==UpdateJournal.Phase.PROBATION);
      callback.localHealthFailed(callback.read(),NEW);callback.recovering("release-11",6);
      callback.reconcileInstallerResult("release-11",6,NEW,true,reason);check(callback.read().phase==UpdateJournal.Phase.SUPPORT);
      callback.reconcile("release-11",6,RECOVERY,false);check(callback.read().phase==UpdateJournal.Phase.RECOVERY_PROBATION);
      callback.installedHealthy(callback.read(),RECOVERY);check(callback.read().phase==UpdateJournal.Phase.RECOVERED);
      UpdateJournal installedWins=new UpdateJournal(directory.resolve("installed-wins-"+reason),SYNC);
      installedWins.begin(plan("stable"),OLD,0);installedWins.committingWithAction("release-11",8,0,FRESH,()->{});
      installedWins.reconcileInstallerResult("release-11",8,NEW,true,reason);check(installedWins.read().phase==UpdateJournal.Phase.PROBATION);
      UpdateJournal unexpected=new UpdateJournal(directory.resolve("unexpected-"+reason),SYNC);
      unexpected.begin(plan("stable"),OLD,0);unexpected.committingWithAction("release-11",8,0,FRESH,()->{});
      unexpected.reconcileInstallerResult("release-11",8,RECOVERY,true,reason);
      check(unexpected.read().reason.equals("unexpected_installed_identity"));check(!UpdateJournal.awaitingInstaller(unexpected.read()));
    }
    UpdateJournal j=new UpdateJournal(directory.resolve("normal"),SYNC);
    check(j.read().channel.equals("stable"));rejects(()->j.begin(plan("beta"),OLD,0));
    j.begin(plan("stable"),OLD,0);j.setChannel("beta");check(j.read().phase==UpdateJournal.Phase.IDLE);
    rejects(()->j.committingWithAction("release-11",1,0,FRESH,()->{}));
    rejects(()->j.begin(plan("stable"),OLD,1));
    j.begin(plan("beta"),OLD,1);j.committingWithAction("release-11",42,1,FRESH,()->{});j.setChannel("stable");
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
    UpdateJournal fail=new UpdateJournal(directory.resolve("fail"),SYNC);fail.begin(plan("stable"),OLD,0);fail.committingWithAction("release-11",1,0,FRESH,()->{});fail.reconcile(NEW,false);fail.localHealthFailed(fail.read(),NEW);fail.recovering("release-11",2);fail.reconcile(NEW,false);check(fail.read().phase==UpdateJournal.Phase.SUPPORT);rejects(()->fail.recovering("release-11",3));
    UpdateJournal badRecovery=new UpdateJournal(directory.resolve("bad-recovery"),SYNC);badRecovery.begin(plan("stable"),OLD,0);badRecovery.committingWithAction("release-11",1,0,FRESH,()->{});badRecovery.reconcile(NEW,false);badRecovery.localHealthFailed(badRecovery.read(),NEW);badRecovery.recovering("release-11",2);badRecovery.reconcile(RECOVERY,false);badRecovery.localHealthFailed(badRecovery.read(),RECOVERY);check(badRecovery.read().phase==UpdateJournal.Phase.SUPPORT);
    check(badRecovery.read().quarantine.contains(RECOVERY.digest));check(!fail.read().quarantine.contains(RECOVERY.digest));
    badRecovery.setChannel("beta");badRecovery.setChannel("stable");check(badRecovery.read().quarantine.contains(RECOVERY.digest));
    // A session lost or timed out with the baseline still running is released,
    // never left in support for good; a live session or a recovery is kept.
    for(String stall:new String[]{"install_timeout","install_clock_invalid","policy_blocked","user_action_required"}) {
      UpdateJournal stalled=new UpdateJournal(directory.resolve("stalled-"+stall),SYNC);stalled.begin(plan("stable"),OLD,0);stalled.committingWithAction("release-11",3,0,FRESH,()->{});
      if(stall.equals("install_timeout")){stalled.observePending("release-11",3,10,0,1000);stalled.observePending("release-11",3,10,1000,1000);}
      else if(stall.equals("install_clock_invalid")){stalled.observePending("release-11",3,10,500,1000);stalled.observePending("release-11",3,10,100,1000);}
      else stalled.reconcileInstallerResult("release-11",3,OLD,true,stall);
      check(stalled.read().reason.equals(stall));
      stalled.reconcile("release-11",3,OLD,true);check(stalled.read().reason.equals(stall));
      long generation=stalled.read().channelGeneration;
      stalled.reconcile("release-11",3,OLD,false);check(stalled.read().reason.equals(UpdateJournal.OUTCOME_UNKNOWN));
      stalled.observeOutcomeUnknown("release-11",3,10,0);stalled.observeOutcomeUnknown("release-11",3,10,UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS);
      check(stalled.read().phase==UpdateJournal.Phase.IDLE);check(stalled.read().plan==null);check(stalled.read().reason.equals("install_not_completed"));
      check(stalled.read().quarantine.isEmpty());check(stalled.read().channelGeneration==generation);check(!UpdateJournal.awaitingInstaller(stalled.read()));
      stalled.begin(plan("stable"),OLD,generation);check(stalled.read().phase==UpdateJournal.Phase.VERIFIED);
    }
    UpdateJournal stalledRecovery=new UpdateJournal(directory.resolve("stalled-recovery"),SYNC);stalledRecovery.begin(plan("stable"),OLD,0);stalledRecovery.committingWithAction("release-11",3,0,FRESH,()->{});stalledRecovery.reconcile(NEW,false);
    stalledRecovery.localHealthFailed(stalledRecovery.read(),NEW);stalledRecovery.recovering("release-11",4);stalledRecovery.observePending("release-11",4,10,0,1000);stalledRecovery.observePending("release-11",4,10,1000,1000);
    stalledRecovery.reconcile("release-11",4,NEW,false);check(stalledRecovery.read().phase==UpdateJournal.Phase.SUPPORT);check(stalledRecovery.read().reason.equals("install_timeout"));
    // A throw from the platform handoff after the durable intent is reported as
    // such, so the coordinator keeps the session and readback decides.
    UpdateJournal binder=new UpdateJournal(directory.resolve("binder"),SYNC);binder.begin(plan("stable"),OLD,0);
    try{binder.committingWithAction("release-11",3,0,FRESH,()->{throw new IllegalStateException("binder died");});throw new AssertionError("Handoff failure hidden");}
    catch(UpdateJournal.HandoffFailed expected){check(expected.getCause() instanceof IllegalStateException);}
    check(binder.read().phase==UpdateJournal.Phase.COMMITTING);
    binder.reconcile("release-11",3,OLD,true);check(binder.read().phase==UpdateJournal.Phase.COMMITTING);
    binder.reconcile("release-11",3,NEW,false);check(binder.read().phase==UpdateJournal.Phase.PROBATION);check(binder.read().quarantine.isEmpty());
    UpdateJournal.Plan next=new UpdateJournal.Plan("release-13","stable","launcher",OLD,id(13,'d'),id(14,'e'));
    UpdateJournal second=new UpdateJournal(directory.resolve("binder-unpublished"),SYNC);second.begin(next,OLD,0);
    try{new UpdateJournal(directory.resolve("binder-unpublished"),SYNC,name->{if(name.equals("published"))throw new IOException("lost after rename");}).committingWithAction("release-13",3,0,FRESH,()->{throw new AssertionError("Handoff ran after failed publish");});throw new AssertionError("Publish failure hidden");}
    catch(UpdateJournal.HandoffFailed wrong){throw new AssertionError("Publish failure reported as handoff");}
    catch(IOException expected){assertions++;}
    // Only a reported candidate fault quarantines. A gone session with no report
    // waits observed uptime, not readbacks, for a late callback, then releases.
    UpdateJournal unreported=new UpdateJournal(directory.resolve("unreported"),SYNC);unreported.begin(plan("stable"),OLD,0);unreported.committingWithAction("release-11",3,0,FRESH,()->{});
    unreported.reconcile("release-11",3,OLD,false);check(unreported.read().reason.equals("install_outcome_unknown"));check(unreported.read().quarantine.isEmpty());check(UpdateJournal.awaitingInstaller(unreported.read()));
    rejects(()->unreported.begin(plan("stable"),OLD,0));
    unreported.reconcileInstallerResult("release-11",3,OLD,false,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED);
    check(unreported.read().phase==UpdateJournal.Phase.QUARANTINED);check(unreported.read().quarantine.contains(NEW.digest));check(!unreported.read().quarantine.contains(RECOVERY.digest));
    UpdateJournal unanswered=new UpdateJournal(directory.resolve("unanswered"),SYNC);unanswered.begin(plan("stable"),OLD,0);unanswered.committingWithAction("release-11",3,0,FRESH,()->{});
    unanswered.reconcile("release-11",3,OLD,false);unanswered.reconcile("release-11",3,OLD,false);
    check(unanswered.read().reason.equals(UpdateJournal.OUTCOME_UNKNOWN));check(unanswered.read().pendingMillis==0);
    unanswered.observeOutcomeUnknown("wrong",3,10,0);unanswered.observeOutcomeUnknown("release-11",4,10,0);check(unanswered.read().reason.equals(UpdateJournal.OUTCOME_UNKNOWN));
    unanswered.observeOutcomeUnknown("release-11",3,10,1000);unanswered.reconcile("release-11",3,OLD,false);
    unanswered.observeOutcomeUnknown("release-11",3,10,UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS-1000);check(unanswered.read().pendingMillis==UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS-2000);
    // A backward clock restarts the wait; a reboot counts only the new uptime.
    unanswered.observeOutcomeUnknown("release-11",3,10,500);check(unanswered.read().pendingMillis==0);check(unanswered.read().reason.equals(UpdateJournal.OUTCOME_UNKNOWN));
    unanswered.observeOutcomeUnknown("release-11",3,11,UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS-1);check(unanswered.read().reason.equals(UpdateJournal.OUTCOME_UNKNOWN));
    rejects(()->unanswered.observeOutcomeUnknown("release-11",3,-1,0));
    unanswered.observeOutcomeUnknown("release-11",3,11,UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS);
    check(unanswered.read().phase==UpdateJournal.Phase.IDLE);check(unanswered.read().reason.equals("install_not_completed"));check(unanswered.read().quarantine.isEmpty());
    for(UpdateJournal.InstallerFailure report:UpdateJournal.InstallerFailure.values()) {
      UpdateJournal reported=new UpdateJournal(directory.resolve("reported-"+report),SYNC);reported.begin(plan("stable"),OLD,0);reported.committingWithAction("release-11",3,0,FRESH,()->{});
      // A live session outranks any report.
      reported.reconcileInstallerResult("release-11",3,OLD,true,null,report);check(reported.read().phase==UpdateJournal.Phase.COMMITTING);
      reported.reconcileInstallerResult("release-11",3,OLD,false,null,report);
      boolean rejected=report==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED;
      check(reported.read().phase==(rejected?UpdateJournal.Phase.QUARANTINED:UpdateJournal.Phase.IDLE));check(reported.read().quarantine.isEmpty()!=rejected);
      // A report while the session is listed survives a reopen and a timeout,
      // and decides once the session is gone, even with no second report.
      UpdateJournal early=new UpdateJournal(directory.resolve("reported-early-"+report),SYNC);early.begin(plan("stable"),OLD,0);early.committingWithAction("release-11",3,0,FRESH,()->{});
      early.reconcileInstallerResult("release-11",3,OLD,true,null,report);check(early.read().phase==UpdateJournal.Phase.COMMITTING);
      early.reconcileInstallerResult("release-11",3,OLD,true,null,null);early.reconcileInstallerResult("release-11",3,OLD,true,null,UpdateJournal.InstallerFailure.RETRYABLE);
      early.observePending("release-11",3,10,0,1000);early.observePending("release-11",3,10,1000,1000);check(early.read().reason.equals("install_timeout"));
      early=new UpdateJournal(directory.resolve("reported-early-"+report),SYNC);check(early.read().reportedFailure==report);
      early.reconcile("release-11",3,OLD,false);
      check(early.read().phase==(rejected?UpdateJournal.Phase.QUARANTINED:UpdateJournal.Phase.IDLE));check(early.read().quarantine.isEmpty()!=rejected);check(early.read().reportedFailure==null);
      UpdateJournal landed=new UpdateJournal(directory.resolve("reported-installed-"+report),SYNC);landed.begin(plan("stable"),OLD,0);landed.committingWithAction("release-11",3,0,FRESH,()->{});
      landed.reconcileInstallerResult("release-11",3,NEW,false,null,report);check(landed.read().phase==UpdateJournal.Phase.PROBATION);check(landed.read().quarantine.isEmpty());
    }
    // A candidate released MAX_INSTALL_ATTEMPTS_PER_CANDIDATE times in a row is
    // quarantined, so a lasting block cannot commit the same plan for ever.
    Path budgetRoot=directory.resolve("retry-budget");
    for(int attempt=1;attempt<=UpdateJournal.MAX_INSTALL_ATTEMPTS_PER_CANDIDATE;attempt++) {
      UpdateJournal budget=new UpdateJournal(budgetRoot,SYNC);budget.begin(plan("stable"),OLD,0);budget.committingWithAction("release-11",3,0,FRESH,()->{});
      budget.reconcileInstallerResult("release-11",3,OLD,false,null,UpdateJournal.InstallerFailure.RETRYABLE);
      check(budget.read().releases==attempt);check(budget.read().releasedCandidate.equals(NEW.digest));
      boolean spent=attempt==UpdateJournal.MAX_INSTALL_ATTEMPTS_PER_CANDIDATE;
      check(budget.read().phase==(spent?UpdateJournal.Phase.QUARANTINED:UpdateJournal.Phase.IDLE));
      check(budget.read().reason.equals(spent?UpdateJournal.RETRY_BUDGET_SPENT:UpdateJournal.INSTALL_RELEASED));check(budget.read().quarantine.contains(NEW.digest)==spent);
    }
    UpdateJournal budget=new UpdateJournal(budgetRoot,SYNC);rejects(()->budget.begin(plan("stable"),OLD,0));
    UpdateJournal.Plan other=new UpdateJournal.Plan("release-13","stable","launcher",OLD,id(13,'d'),id(14,'e'));
    budget.begin(other,OLD,0);budget.committingWithAction("release-13",4,0,FRESH,()->{});budget.reconcileInstallerResult("release-13",4,OLD,false,null,UpdateJournal.InstallerFailure.RETRYABLE);
    check(budget.read().phase==UpdateJournal.Phase.IDLE);check(budget.read().releases==1);check(budget.read().releasedCandidate.equals(other.candidate.digest));
    // A candidate that installs ends its releases in a row: the record is
    // cleared, the journal is written as version 4 again, and a later release
    // of the same candidate counts from one.
    Path clearedRoot=directory.resolve("retry-cleared");UpdateJournal cleared=new UpdateJournal(clearedRoot,SYNC);
    for(int attempt=1;attempt<UpdateJournal.MAX_INSTALL_ATTEMPTS_PER_CANDIDATE;attempt++){cleared.begin(plan("stable"),OLD,0);cleared.committingWithAction("release-11",3,0,FRESH,()->{});cleared.reconcileInstallerResult("release-11",3,OLD,false,null,UpdateJournal.InstallerFailure.RETRYABLE);}
    check(cleared.read().releases==UpdateJournal.MAX_INSTALL_ATTEMPTS_PER_CANDIDATE-1);
    check(java.nio.ByteBuffer.wrap(Files.readAllBytes(clearedRoot.resolve("journal"))).getInt(4)==5);
    cleared.begin(plan("stable"),OLD,0);cleared.committingWithAction("release-11",3,0,FRESH,()->{});cleared.reconcile("release-11",3,NEW,false);
    check(cleared.read().phase==UpdateJournal.Phase.PROBATION);check(cleared.read().releases==0);check(cleared.read().releasedCandidate.isEmpty());
    check(java.nio.ByteBuffer.wrap(Files.readAllBytes(clearedRoot.resolve("journal"))).getInt(4)==4);
    cleared.installedHealthy(cleared.read(),NEW);check(new UpdateJournal(clearedRoot,SYNC).read().releases==0);
    UpdateJournal rejectedPair=new UpdateJournal(directory.resolve("rejected-pair"),SYNC);
    rejectedPair.begin(plan("stable"),OLD,0);rejectedPair.committingWithAction("release-11",1,0,FRESH,()->{});
    rejectedPair.reconcileInstallerResult("release-11",1,OLD,false,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED);
    check(rejectedPair.read().phase==UpdateJournal.Phase.QUARANTINED);check(rejectedPair.read().quarantine.contains(NEW.digest));
    UpdateJournal.Plan quarantinedRecovery=new UpdateJournal.Plan("release-13","stable","launcher",OLD,id(13,'d'),id(14,'b'));
    rejects(()->rejectedPair.begin(quarantinedRecovery,OLD,0));
    Path lost=directory.resolve("lost");UpdateJournal loss=new UpdateJournal(lost,SYNC);loss.setChannel("beta");Files.delete(lost.resolve("journal"));rejects(loss::read);rejects(()->loss.setChannel("stable"));
    java.util.concurrent.atomic.AtomicBoolean cleanupOnLostJournal=new java.util.concurrent.atomic.AtomicBoolean(false);
    rejects(()->loss.withLockedSnapshot(state->cleanupOnLostJournal.set(true)));check(!cleanupOnLostJournal.get());
    Path interrupted=directory.resolve("first-write");UpdateJournal firstWrite=new UpdateJournal(interrupted,SYNC,name->{if(name.equals("before-sync"))throw new IOException("simulated first-write failure");});
    // A failed or full first write leaves a new device, never a missing journal.
    rejects(()->firstWrite.setChannel("beta"));check(new UpdateJournal(interrupted,SYNC).read().revision==0);check(!Files.exists(interrupted.resolve("initialized")));
    new UpdateJournal(interrupted,SYNC).setChannel("beta");check(new UpdateJournal(interrupted,SYNC).read().channel.equals("beta"));
    Path unmarked=directory.resolve("marker-write");UpdateJournal markerWrite=new UpdateJournal(unmarked,SYNC,name->{if(name.equals("marker-before-rename"))throw new IOException("simulated full storage");});
    rejects(()->markerWrite.setChannel("beta"));check(!Files.exists(unmarked.resolve("initialized")));
    check(new UpdateJournal(unmarked,SYNC).read().channel.equals("beta"));check(Files.readAllBytes(unmarked.resolve("initialized")).length==1);
    Files.delete(unmarked.resolve("journal"));rejects(()->new UpdateJournal(unmarked,SYNC).read());
    for(String boundary:new String[]{"marker-before-sync","marker-before-rename"}) {
      Path root=directory.resolve("first-"+boundary);
      Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),UpdateJournalTest.class.getName(),root.toString(),boundary).inheritIO().start();check(child.waitFor()==24);
      check(new UpdateJournal(root,SYNC).read().channel.equals("beta"));check(Files.readAllBytes(root.resolve("initialized")).length==1);
    }
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
      var committed=handoffPool.submit(()->{try{handoff.committingWithAction("release-11",7,0,FRESH,()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}});}catch(IOException e){throw new RuntimeException(e);}});
      check(entered.await(2,java.util.concurrent.TimeUnit.SECONDS));
      var changed=handoffPool.submit(()->{changing.countDown();try{handoff.setChannel("beta");}catch(IOException e){throw new RuntimeException(e);}});
      check(changing.await(2,java.util.concurrent.TimeUnit.SECONDS));
      try {changed.get(100,java.util.concurrent.TimeUnit.MILLISECONDS);throw new AssertionError("Channel crossed pending platform handoff");}catch(java.util.concurrent.TimeoutException expected){assertions++;}
      release.countDown();committed.get();changed.get();check(handoff.read().phase==UpdateJournal.Phase.COMMITTING);check(handoff.read().channel.equals("beta"));
    } finally {release.countDown();handoffPool.shutdownNow();}
    UpdateJournal stale=new UpdateJournal(directory.resolve("stale-handoff"),SYNC);stale.begin(plan("stable"),OLD,0);stale.setChannel("beta");
    java.util.concurrent.atomic.AtomicBoolean called=new java.util.concurrent.atomic.AtomicBoolean();rejects(()->stale.committingWithAction("release-11",8,0,FRESH,()->called.set(true)));check(!called.get());
    Path failedHandoff=directory.resolve("failed-handoff");new UpdateJournal(failedHandoff,SYNC).begin(plan("stable"),OLD,0);
    UpdateJournal failedWrite=new UpdateJournal(failedHandoff,SYNC,name->{if(name.equals("before-sync"))throw new IOException("persist failed");});
    rejects(()->failedWrite.committingWithAction("release-11",8,0,FRESH,()->called.set(true)));check(!called.get());
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
    commitFreshnessAndDeadRecovery(directory);
    System.out.println("UpdateJournal: "+assertions+" assertions passed; 11 real process-death boundaries");
  }
  /** Admission is not a lasting permission, and a recovery that can never load
   * must not hold the journal in RECOVERY_READY. */
  static void commitFreshnessAndDeadRecovery(Path directory)throws Exception {
    // Commit runs the freshness check under the lock, with the journal's plan,
    // before the intent is written. A refusal leaves the plan VERIFIED.
    UpdateJournal fenced=new UpdateJournal(directory.resolve("commit-freshness"),SYNC);fenced.begin(plan("stable"),OLD,0);
    long before=fenced.read().revision;java.util.List<String> seen=new ArrayList<>();
    java.util.concurrent.atomic.AtomicBoolean called=new java.util.concurrent.atomic.AtomicBoolean();
    rejects(()->fenced.committingWithAction("release-11",9,0,(p,g)->{seen.add(p.id+"@"+g);throw new IOException("revoked-artifact");},()->called.set(true)));
    check(!called.get());check(seen.equals(List.of("release-11@0")));
    check(fenced.read().phase==UpdateJournal.Phase.VERIFIED&&fenced.read().revision==before&&fenced.read().sessionId==-1);
    boolean[] nulls={false,false};
    try{fenced.committingWithAction("release-11",9,0,null,()->{});}catch(NullPointerException expected){nulls[0]=true;}
    check(nulls[0]&&fenced.read().phase==UpdateJournal.Phase.VERIFIED);
    // A plan whose stale check never ran is refused before the check is asked.
    rejects(()->fenced.committingWithAction("release-12",9,0,(p,g)->{nulls[1]=true;},()->{}));check(!nulls[1]);
    fenced.committingWithAction("release-11",9,0,FRESH,()->{});check(fenced.read().phase==UpdateJournal.Phase.COMMITTING);
    // Every public way into COMMITTING takes a freshness check.
    for(java.lang.reflect.Method method:UpdateJournal.class.getDeclaredMethods())
      if(java.lang.reflect.Modifier.isPublic(method.getModifiers())&&method.getName().startsWith("committing"))
        check(Arrays.asList(method.getParameterTypes()).contains(UpdateJournal.FreshnessCheck.class));
    // A refresh can drop a VERIFIED plan; quarantine and generation stay.
    UpdateJournal dropped=new UpdateJournal(directory.resolve("discard-verified"),SYNC);dropped.begin(plan("stable"),OLD,0);
    rejects(()->dropped.discardVerified("release-11",1,"revoked-artifact"));rejects(()->dropped.discardVerified("release-12",0,"revoked-artifact"));
    try{dropped.discardVerified("release-11",0,"Revoked: yes");throw new AssertionError("Bad reason accepted");}catch(IllegalArgumentException expected){assertions++;}
    UpdateJournal.Snapshot idle=dropped.discardVerified("release-11",0,"revoked-artifact");
    check(idle.phase==UpdateJournal.Phase.IDLE&&idle.plan==null&&idle.reason.equals("verified_invalidated:revoked-artifact")&&idle.channelGeneration==0&&idle.quarantine.isEmpty());
    rejects(()->dropped.discardVerified("release-11",0,"revoked-artifact"));
    dropped.begin(plan("stable"),OLD,0);dropped.committingWithAction("release-11",3,0,FRESH,()->{});rejects(()->dropped.discardVerified("release-11",0,"expired"));
    // A recovery that can never load ends RECOVERY_READY, and a newer release
    // can then fix the failed candidate forward.
    UpdateJournal stuck=new UpdateJournal(directory.resolve("recovery-unavailable"),SYNC);stuck.begin(plan("stable"),OLD,0);
    rejects(()->stuck.recoveryUnavailable("release-11","revoked-artifact"));
    stuck.committingWithAction("release-11",3,0,FRESH,()->{});stuck.reconcile(NEW,false);stuck.localHealthFailed(stuck.read(),NEW);
    rejects(()->stuck.stageValidated(new UpdateJournal.Plan("release-13","stable","launcher",NEW,id(13,'d'),id(14,'e')),NEW,0,()->{}));
    rejects(()->stuck.recoveryUnavailable("release-12","revoked-artifact"));
    UpdateJournal.Snapshot ended=stuck.recoveryUnavailable("release-11","revoked-artifact");
    check(ended.phase==UpdateJournal.Phase.QUARANTINED&&ended.reason.equals("recovery_unavailable:revoked-artifact")&&ended.quarantine.equals(Set.of(NEW.digest,RECOVERY.digest)));
    rejects(()->stuck.recovering("release-11",4));
    check(stuck.stageValidated(new UpdateJournal.Plan("release-13","stable","launcher",NEW,id(13,'d'),id(14,'e')),NEW,0,()->{}).phase==UpdateJournal.Phase.STAGING);
    UpdateJournal tried=new UpdateJournal(directory.resolve("recovery-tried"),SYNC);tried.begin(plan("stable"),OLD,0);
    tried.committingWithAction("release-11",3,0,FRESH,()->{});tried.reconcile(NEW,false);tried.localHealthFailed(tried.read(),NEW);tried.recovering("release-11",4);
    rejects(()->tried.recoveryUnavailable("release-11","revoked-artifact"));
  }
}

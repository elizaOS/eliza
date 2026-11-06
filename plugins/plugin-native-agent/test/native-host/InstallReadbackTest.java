package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
/** InstallReadback against a scripted PackageInstaller: an own session is
 * abandoned only when the platform reports it uncommitted. */
public final class InstallReadbackTest {
  static int assertions;
  static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
  static final UpdateJournal.Durability SYNC=p->{try(FileChannel f=FileChannel.open(p,StandardOpenOption.READ)){f.force(true);}};
  static UpdateJournal.Identity id(long code,char c){char[] bytes=new char[64];Arrays.fill(bytes,c);return new UpdateJournal.Identity(code,new String(bytes));}
  static final UpdateJournal.Identity OLD=id(10,'a'),NEW=id(11,'b'),RECOVERY=id(12,'c');
  static final UpdateJournal.Plan PLAN=new UpdateJournal.Plan("release-11","stable","launcher",OLD,NEW,RECOVERY);
  static final class Platform implements InstallReadback.Platform {
    InstallReadback.Session session;UpdateJournal.Identity installed=OLD;long boot=10,elapsed=0;boolean abandonFails;
    final List<Integer> abandoned=new ArrayList<>();
    Platform(InstallReadback.Session session){this.session=session;}
    @Override public UpdateJournal.Identity installed(){return installed;}
    @Override public InstallReadback.Session session(int id){return session;}
    @Override public void abandon(int id){if(abandonFails)throw new SecurityException("not owner");abandoned.add(id);session=InstallReadback.Session.GONE;}
    @Override public long bootCount(){return boot;}
    @Override public long elapsedRealtime(){return elapsed;}
  }
  static UpdateJournal committing(Path root,String name)throws IOException {
    UpdateJournal journal=new UpdateJournal(root.resolve(name),SYNC);journal.begin(PLAN,OLD,0);journal.committing("release-11",3,0);return journal;
  }
  public static void main(String[] args)throws Exception {
    Path root=Path.of(args[0]);Files.createDirectories(root);
    // The process died, or Session.commit was refused, after the durable
    // COMMITTING record: the uncommitted session is abandoned and released.
    for(String name:new String[]{"died-before-commit","refused-commit"}) {
      UpdateJournal journal=new UpdateJournal(root.resolve(name),SYNC);journal.begin(PLAN,OLD,0);
      if(name.equals("died-before-commit"))journal.committing("release-11",3,0);
      else try{journal.committingWithAction("release-11",3,0,()->{throw new SecurityException("refused");});throw new AssertionError();}catch(UpdateJournal.HandoffFailed expected){assertions++;}
      Platform platform=new Platform(InstallReadback.Session.UNCOMMITTED);
      UpdateJournal.Snapshot after=InstallReadback.reconcile(journal,platform,1000);
      check(platform.abandoned.equals(List.of(3)),name+": uncommitted session kept");
      check(after.phase==UpdateJournal.Phase.IDLE&&after.reason.equals(UpdateJournal.INSTALL_RELEASED)&&after.quarantine.isEmpty(),name+": not released");
      journal.begin(PLAN,OLD,0);check(journal.read().phase==UpdateJournal.Phase.VERIFIED,name+": new release not admitted");
    }
    // A session stuck in support after a timeout is abandoned the same way.
    UpdateJournal timeout=committing(root,"timeout");timeout.observePending("release-11",3,10,0,1000);timeout.observePending("release-11",3,10,1000,1000);
    check(timeout.read().reason.equals("install_timeout"),"timeout not reached");
    Platform stuck=new Platform(InstallReadback.Session.UNCOMMITTED);
    check(InstallReadback.reconcile(timeout,stuck,1000).reason.equals(UpdateJournal.INSTALL_RELEASED),"timed out uncommitted session not released");
    // Committed and unknown sessions are never abandoned; their time is counted.
    for(InstallReadback.Session kept:new InstallReadback.Session[]{InstallReadback.Session.COMMITTED,InstallReadback.Session.UNKNOWN}) {
      UpdateJournal journal=committing(root,"kept-"+kept);Platform platform=new Platform(kept);
      InstallReadback.reconcile(journal,platform,1000);platform.elapsed=400;InstallReadback.reconcile(journal,platform,1000);
      check(platform.abandoned.isEmpty(),kept+" session abandoned");
      check(journal.read().phase==UpdateJournal.Phase.COMMITTING&&journal.read().pendingMillis==400,kept+" session not observed");
      platform.elapsed=1400;check(InstallReadback.reconcile(journal,platform,1000).reason.equals("install_timeout"),kept+" session never timed out");
      platform.elapsed=5000;InstallReadback.reconcile(journal,platform,1000);check(platform.abandoned.isEmpty()&&journal.read().reason.equals("install_timeout"),kept+" session left support");
      // The platform finally installs: readback wins over the timeout.
      platform.installed=NEW;platform.session=InstallReadback.Session.GONE;
      check(InstallReadback.reconcile(journal,platform,1000).phase==UpdateJournal.Phase.PROBATION,kept+" install missed");
    }
    // A gone session with no report waits OUTCOME_UNKNOWN_WAIT_MS of uptime.
    UpdateJournal gone=committing(root,"gone");Platform lost=new Platform(InstallReadback.Session.GONE);lost.elapsed=1000;
    check(InstallReadback.reconcile(gone,lost,1000).reason.equals(UpdateJournal.OUTCOME_UNKNOWN),"gone session not marked unknown");
    lost.elapsed=1000+UpdateJournal.OUTCOME_UNKNOWN_WAIT_MS-1;check(InstallReadback.reconcile(gone,lost,1000).reason.equals(UpdateJournal.OUTCOME_UNKNOWN),"released before the wait");
    lost.elapsed++;check(InstallReadback.reconcile(gone,lost,1000).reason.equals(UpdateJournal.INSTALL_RELEASED),"never released");
    check(lost.abandoned.isEmpty(),"gone session abandoned");
    // A failed abandon changes nothing; an uncommitted recovery stays in support.
    UpdateJournal refused=committing(root,"abandon-fails");Platform owner=new Platform(InstallReadback.Session.UNCOMMITTED);owner.abandonFails=true;
    long revision=refused.read().revision;
    try{InstallReadback.reconcile(refused,owner,1000);throw new AssertionError("Abandon failure hidden");}catch(IOException expected){assertions++;}
    check(refused.read().phase==UpdateJournal.Phase.COMMITTING&&refused.read().revision==revision,"failed abandon changed the journal");
    UpdateJournal recovery=committing(root,"recovery");recovery.reconcile("release-11",3,NEW,false);recovery.localHealthFailed(recovery.read(),NEW);recovery.recovering("release-11",4);
    Platform recoveryPlatform=new Platform(InstallReadback.Session.UNCOMMITTED);recoveryPlatform.installed=NEW;
    UpdateJournal.Snapshot recovered=InstallReadback.reconcile(recovery,recoveryPlatform,1000);
    check(recoveryPlatform.abandoned.equals(List.of(4))&&recovered.phase==UpdateJournal.Phase.SUPPORT&&recovered.reason.equals("recovery_install_failed"),"uncommitted recovery");
    // Nothing awaited: the platform is not touched.
    UpdateJournal idle=new UpdateJournal(root.resolve("idle"),SYNC);Platform untouched=new Platform(InstallReadback.Session.UNCOMMITTED);
    InstallReadback.reconcile(idle,untouched,1000);check(untouched.abandoned.isEmpty()&&idle.read().phase==UpdateJournal.Phase.IDLE,"idle journal touched the platform");
    System.out.println("InstallReadback: "+assertions+" assertions passed");
  }
}

package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
/** InstallReadback against a scripted PackageInstaller: an own session is
 * abandoned only when the platform has reported it uncommitted for long
 * enough, never while a just-sealed session is still being verified. */
public final class InstallReadbackTest {
  /** A plan that is still fresh: these cases are about the install, not commit freshness. */
  static final UpdateJournal.FreshnessCheck FRESH=(plan,generation)->{};
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
    UpdateJournal journal=new UpdateJournal(root.resolve(name),SYNC);journal.begin(PLAN,OLD,0);journal.committingWithAction("release-11",3,0,FRESH,()->{});return journal;
  }
  public static void main(String[] args)throws Exception {
    Path root=Path.of(args[0]);Files.createDirectories(root);
    // The process died, or Session.commit was refused, after the durable
    // COMMITTING record: the session stays uncommitted, so once it has been
    // observed that way for UNCOMMITTED_ABANDON_WAIT_MS it is abandoned and
    // the plan released. The budget is longer, so the wait alone decides.
    long wait=InstallReadback.UNCOMMITTED_ABANDON_WAIT_MS,budget=2*wait;
    for(String name:new String[]{"died-before-commit","refused-commit"}) {
      UpdateJournal journal=new UpdateJournal(root.resolve(name),SYNC);journal.begin(PLAN,OLD,0);
      if(name.equals("died-before-commit"))journal.committingWithAction("release-11",3,0,FRESH,()->{});
      else try{journal.committingWithAction("release-11",3,0,FRESH,()->{throw new SecurityException("refused");});throw new AssertionError();}catch(UpdateJournal.HandoffFailed expected){assertions++;}
      Platform platform=new Platform(InstallReadback.Session.UNCOMMITTED);
      check(InstallReadback.reconcile(journal,platform,budget).phase==UpdateJournal.Phase.COMMITTING&&platform.abandoned.isEmpty(),name+": abandoned at once");
      platform.elapsed=wait-1;check(InstallReadback.reconcile(journal,platform,budget).phase==UpdateJournal.Phase.COMMITTING&&platform.abandoned.isEmpty(),name+": abandoned before the wait");
      platform.elapsed=wait;InstallReadback.reconcile(journal,platform,budget);
      UpdateJournal.Snapshot after=InstallReadback.reconcile(journal,platform,budget);
      check(platform.abandoned.equals(List.of(3)),name+": uncommitted session kept");
      check(after.phase==UpdateJournal.Phase.IDLE&&after.reason.equals(UpdateJournal.INSTALL_RELEASED)&&after.quarantine.isEmpty()&&after.releases==1,name+": not released");
      journal.begin(PLAN,OLD,0);check(journal.read().phase==UpdateJournal.Phase.VERIFIED,name+": new release not admitted");
    }
    // Session.commit returned, but on API 31 and later the sealed session
    // reads uncommitted until the platform has verified the APK. A reconcile
    // in that window, such as the job requested right after the handoff, keeps
    // it and spends no retry; the platform then commits and installs it.
    UpdateJournal sealed=new UpdateJournal(root.resolve("sealed"),SYNC);sealed.begin(PLAN,OLD,0);
    sealed.committingWithAction("release-11",3,0,FRESH,()->{});
    Platform validating=new Platform(InstallReadback.Session.UNCOMMITTED);
    for(long at:new long[]{0,1000,5000}){validating.elapsed=at;InstallReadback.reconcile(sealed,validating,budget);}
    check(validating.abandoned.isEmpty()&&sealed.read().phase==UpdateJournal.Phase.COMMITTING&&sealed.read().releases==0,"sealed session abandoned while the platform verified it");
    validating.session=InstallReadback.Session.COMMITTED;validating.elapsed=wait+5000;InstallReadback.reconcile(sealed,validating,budget);
    check(validating.abandoned.isEmpty()&&sealed.read().phase==UpdateJournal.Phase.COMMITTING,"committed session abandoned");
    validating.session=InstallReadback.Session.GONE;validating.installed=NEW;
    check(InstallReadback.reconcile(sealed,validating,budget).phase==UpdateJournal.Phase.PROBATION,"sealed install missed");
    // A host budget shorter than the wait does not time out an uncommitted
    // candidate early: a sealed one being verified still gets the full wait.
    UpdateJournal shortBudget=committing(root,"short-budget");Platform verifying=new Platform(InstallReadback.Session.UNCOMMITTED);long hostBudget=wait/15;
    for(long at:new long[]{0,2*hostBudget,wait-1}){verifying.elapsed=at;InstallReadback.reconcile(shortBudget,verifying,hostBudget);
      check(shortBudget.read().phase==UpdateJournal.Phase.COMMITTING&&verifying.abandoned.isEmpty(),"uncommitted candidate timed out at the host budget");}
    verifying.elapsed=wait;InstallReadback.reconcile(shortBudget,verifying,hostBudget);
    check(InstallReadback.reconcile(shortBudget,verifying,hostBudget).reason.equals(UpdateJournal.INSTALL_RELEASED)&&verifying.abandoned.equals(List.of(3)),"uncommitted candidate not released after the wait");
    // A committed candidate still times out at the host budget.
    UpdateJournal committedShort=committing(root,"committed-short-budget");Platform committedPlatform=new Platform(InstallReadback.Session.COMMITTED);
    InstallReadback.reconcile(committedShort,committedPlatform,hostBudget);committedPlatform.elapsed=hostBudget;
    check(InstallReadback.reconcile(committedShort,committedPlatform,hostBudget).reason.equals("install_timeout"),"committed candidate ignored the host budget");
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
    // A failed abandon changes nothing.
    UpdateJournal refused=committing(root,"abandon-fails");refused.observePending("release-11",3,10,0,1000);refused.observePending("release-11",3,10,1000,1000);
    Platform owner=new Platform(InstallReadback.Session.UNCOMMITTED);owner.abandonFails=true;
    long revision=refused.read().revision;
    try{InstallReadback.reconcile(refused,owner,1000);throw new AssertionError("Abandon failure hidden");}catch(IOException expected){assertions++;}
    check(refused.read().phase==UpdateJournal.Phase.SUPPORT&&refused.read().revision==revision,"failed abandon changed the journal");
    // Recovery is attempted once, so an uncommitted recovery session is never
    // abandoned before the host's install timeout, even past the candidate
    // wait: a sealed recovery being verified installs. After the timeout it is
    // abandoned and the journal stays in support.
    UpdateJournal recovery=committing(root,"recovery");recovery.reconcile("release-11",3,NEW,false);recovery.localHealthFailed(recovery.read(),NEW);
    recovery.recoveringWithAction("release-11",4,()->{});
    Platform recoveryPlatform=new Platform(InstallReadback.Session.UNCOMMITTED);recoveryPlatform.installed=NEW;
    for(long at:new long[]{0,1000,wait+1000}){recoveryPlatform.elapsed=at;InstallReadback.reconcile(recovery,recoveryPlatform,budget);}
    check(recoveryPlatform.abandoned.isEmpty()&&recovery.read().phase==UpdateJournal.Phase.RECOVERING,"recovery session abandoned before the install timeout");
    recoveryPlatform.elapsed=budget;check(InstallReadback.reconcile(recovery,recoveryPlatform,budget).reason.equals("install_timeout"),"recovery never timed out");
    UpdateJournal.Snapshot recovered=InstallReadback.reconcile(recovery,recoveryPlatform,budget);
    check(recoveryPlatform.abandoned.equals(List.of(4))&&recovered.phase==UpdateJournal.Phase.SUPPORT&&recovered.reason.equals("install_timeout"),"timed out recovery");
    UpdateJournal sealedRecovery=committing(root,"sealed-recovery");sealedRecovery.reconcile("release-11",3,NEW,false);sealedRecovery.localHealthFailed(sealedRecovery.read(),NEW);
    sealedRecovery.recoveringWithAction("release-11",5,()->{});
    Platform recoveryValidating=new Platform(InstallReadback.Session.UNCOMMITTED);recoveryValidating.installed=NEW;
    InstallReadback.reconcile(sealedRecovery,recoveryValidating,budget);
    recoveryValidating.session=InstallReadback.Session.GONE;recoveryValidating.installed=RECOVERY;
    check(recoveryValidating.abandoned.isEmpty()&&InstallReadback.reconcile(sealedRecovery,recoveryValidating,budget).phase==UpdateJournal.Phase.RECOVERY_PROBATION,"sealed recovery missed");
    // A clock fault proves no elapsed time, so the session is kept.
    UpdateJournal skewed=committing(root,"clock");skewed.observePending("release-11",3,10,500,budget);skewed.observePending("release-11",3,10,100,budget);
    Platform skewedPlatform=new Platform(InstallReadback.Session.UNCOMMITTED);skewedPlatform.elapsed=200;
    check(InstallReadback.reconcile(skewed,skewedPlatform,budget).reason.equals("install_clock_invalid")&&skewedPlatform.abandoned.isEmpty(),"session abandoned on a clock fault");
    // Nothing awaited: the platform is not touched.
    UpdateJournal idle=new UpdateJournal(root.resolve("idle"),SYNC);Platform untouched=new Platform(InstallReadback.Session.UNCOMMITTED);
    InstallReadback.reconcile(idle,untouched,1000);check(untouched.abandoned.isEmpty()&&idle.read().phase==UpdateJournal.Phase.IDLE,"idle journal touched the platform");
    System.out.println("InstallReadback: "+assertions+" assertions passed");
  }
}

package ai.eliza.plugins.agent.updater;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;

public final class PreparedRecoveryTest {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }
  private interface Operation { void run() throws Exception; }
  private static void rejects(Operation op) throws Exception {
    try { op.run(); throw new AssertionError("Expected rejection"); }
    catch (IOException expected) { assertions++; }
  }
  private static UpdateJournal.Identity identity(long code, char c) {
    char[] hash = new char[64]; Arrays.fill(hash, c); return new UpdateJournal.Identity(code, new String(hash));
  }
  private static final UpdateJournal.Identity OLD=identity(1,'a'), CURRENT=identity(2,'b'), RECOVERY=identity(3,'c');
  private static UpdateJournal journal(Path path) throws Exception {
    return new UpdateJournal(path, p -> { try (FileChannel f=FileChannel.open(p,StandardOpenOption.READ)) { f.force(true); } });
  }
  private static UpdateJournal ready(Path path) throws Exception {
    UpdateJournal j=journal(path);
    j.begin(new UpdateJournal.Plan("recovery-test","stable","launcher",OLD,CURRENT,RECOVERY),OLD,0);
    j.committing("recovery-test",1,0);j.reconcile(CURRENT,false);j.localHealthFailed(j.read(),CURRENT);
    return j;
  }
  private static PreparedRecovery.Material material() { return new PreparedRecovery.Material("launcher",new byte[]{1,2},"artifacts.example"); }
  public static void main(String[] args) throws Exception {
    Path root=Path.of(args[0]);Files.createDirectories(root);AtomicInteger calls=new AtomicInteger();
    PreparedRecovery.Authority authority=(plan,floor)->{calls.incrementAndGet();check(plan.id.equals("recovery-test"));check(floor==7);return material();};
    UpdateJournal idle=journal(root.resolve("idle"));
    rejects(()->PreparedRecovery.open(idle,()->CURRENT,authority,7));check(calls.get()==0);
    UpdateJournal valid=ready(root.resolve("valid"));long revision=valid.read().revision;
    rejects(()->PreparedRecovery.open(valid,()->OLD,authority,7));
    rejects(()->PreparedRecovery.open(valid,()->null,authority,7));check(calls.get()==0);
    PreparedRecovery.Authorization value=PreparedRecovery.open(valid,()->CURRENT,authority,7);
    check(value.planId.equals("recovery-test"));check(value.securityFloor==7);check(value.material.approvedHosts.equals("artifacts.example"));
    check(valid.read().revision==revision);check(valid.read().phase==UpdateJournal.Phase.RECOVERY_READY);
    byte[] input={1};PreparedRecovery.Material copied=new PreparedRecovery.Material("launcher",input,"host");input[0]=9;
    check(copied.artifact()[0]==1);byte[] output=copied.artifact();output[0]=8;check(copied.artifact()[0]==1);
    rejects(()->PreparedRecovery.open(valid,()->CURRENT,(p,f)->null,7));
    rejects(()->PreparedRecovery.open(valid,()->CURRENT,(p,f)->new PreparedRecovery.Material("standalone",new byte[]{1},"host"),7));
    rejects(()->PreparedRecovery.open(valid,()->CURRENT,(p,f)->{throw new IOException("authority failure");},7));
    UpdateJournal changed=ready(root.resolve("channel"));
    rejects(()->PreparedRecovery.open(changed,()->CURRENT,(p,f)->{changed.setChannel("beta");return material();},7));
    UpdateJournal installing=ready(root.resolve("installing"));
    rejects(()->PreparedRecovery.open(installing,()->CURRENT,(p,f)->{installing.recoveringWithAction(p.id,2,()->{});return material();},7));
    AtomicInteger reads=new AtomicInteger();
    rejects(()->PreparedRecovery.open(valid,()->reads.incrementAndGet()==1?CURRENT:OLD,(p,f)->material(),7));
    check(valid.read().revision==revision);
    System.out.println("PreparedRecovery: "+assertions+" assertions passed");
  }
}

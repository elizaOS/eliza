package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.file.*;
import java.util.*;
public final class PreparedAuthorizationStoreTest {
 static int assertions;
 static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
 interface Operation{void run()throws Exception;}
 static void rejects(Operation op)throws Exception{try{op.run();throw new AssertionError("Expected rejection");}catch(IOException expected){assertions++;}}
 public static void main(String[] args)throws Exception {
  Path root=Path.of(args[0]);Files.createDirectories(root);
  UpdateJournal journal=new UpdateJournal(root.resolve("journal"),UpdateJournalTest.SYNC);
  UpdateJournal.Plan plan=UpdateJournalTest.plan("stable");
  byte[] candidate={1,2},recovery={3,4};List<String> retained=new ArrayList<>();int[] verified={0};boolean[] reject={false};
  PreparedAuthorizationStore store=new PreparedAuthorizationStore(journal,root.toFile(),new PreparedAuthorizationStore.Authority(){
   public void prune(String directory,String keep)throws Exception{check(directory.equals(root.toAbsolutePath().toString()));retained.add(keep);if(reject[0])throw new IOException("prune denied");}
   public void verify(String directory,UpdateJournal.Plan actual,long generation,byte[] c,byte[] r)throws Exception{
    verified[0]++;check(directory.equals(root.toAbsolutePath().toString()));check(actual==plan);check(generation==0);check(c==candidate&&r==recovery);if(reject[0])throw new IOException("missing permit");
   }
  });
  store.prune();check(retained.equals(List.of("")));
  journal.stageValidated(plan,plan.baseline,0,()->{});store.prune();check(retained.get(1).equals(plan.id));
  reject[0]=true;rejects(()->store.begin(plan,plan.baseline,0,candidate,recovery));check(journal.read().phase==UpdateJournal.Phase.STAGING);
  rejects(store::prune);check(journal.read().plan.id.equals(plan.id));
  reject[0]=false;store.begin(plan,plan.baseline,0,candidate,recovery);check(journal.read().phase==UpdateJournal.Phase.VERIFIED);check(verified[0]==2);
  journal.setChannel("beta");store.prune();check(retained.get(retained.size()-1).equals(""));
  rejects(()->store.begin(plan,plan.baseline,0,candidate,recovery));check(verified[0]==2);check(journal.read().phase==UpdateJournal.Phase.IDLE);
  System.out.println("PreparedAuthorizationStore: "+assertions+" assertions passed");
 }
}

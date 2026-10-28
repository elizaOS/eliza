package ai.elizaos.app;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.security.MessageDigest;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual observation/cache/wait code, with real host files behind its FD source seam.
 * Android Os/LocalSocket calls are outside this host test; device qualification stays required. */
public class ResidentStopDigestObservationTest {
 static final class FilesUnderTest implements AutoCloseable {
  final Path dir=Files.createTempDirectory("resident-stop-observation-");
  int opens,hashes,closes;long bytes,clock;boolean mutateDuringHash,mutateWithoutMetadata;
  FilesUnderTest()throws Exception{}
  File file(String name)throws Exception{Path p=dir.resolve(name);Files.write(p,new byte[]{1,2,3,4});return p.toFile();}
  WorkflowSurvivorInventory.DigestFile open(File file)throws Exception {
   opens++;final FileInputStream in=new FileInputStream(file);final Object held=Files.readAttributes(file.toPath(),BasicFileAttributes.class).fileKey();
   return new WorkflowSurvivorInventory.DigestFile(){
    public String identity()throws Exception {
     BasicFileAttributes a=Files.readAttributes(file.toPath(),BasicFileAttributes.class);
     if(!held.equals(a.fileKey()))throw new IOException("FD/path replaced");
     return a.fileKey()+":"+in.getChannel().size()+":"+a.lastModifiedTime()+":"+Files.getAttribute(file.toPath(),"unix:ctime");
    }
    public String digest(long deadline)throws Exception {
     hashes++;in.getChannel().position(0);MessageDigest sha=MessageDigest.getInstance("SHA-256");byte[] b=new byte[65536];int n;
     while((n=in.read(b))!=-1){clock++;if(clock>=deadline)throw new IOException("worker inventory deadline");bytes+=n;sha.update(b,0,n);}
     if(mutateDuringHash)Files.write(file.toPath(),new byte[]{4,3,2,1});
     byte[] result=sha.digest();if(mutateWithoutMetadata)result[0]^=1;return Arrays.toString(result);
    }
    public void close()throws IOException{closes++;in.close();}
   };
  }
  WorkflowSurvivorInventory.ExecutableDigests observation(){return new WorkflowSurvivorInventory.ExecutableDigests(this::open);}
  public void close()throws Exception{try(var paths=Files.walk(dir)){for(Path p:paths.sorted(Comparator.reverseOrder()).toArray(Path[]::new))Files.deleteIfExists(p);}}
 }
 @Test public void samePhysicalExecutableIsHashedOncePerObservationThenFreshBeforeSignal()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");Path alias=f.dir.resolve("exe-link");Files.createSymbolicLink(alias,exe.toPath());
   try(var observation=f.observation()){
    String first=observation.digest(exe,5000,false);
    for(int n=0;n<20;n++)assertEquals(first,observation.digest(alias.toFile(),5000,false));
    assertEquals(1,f.hashes);assertEquals(first,observation.digest(exe,5000,true));assertEquals(2,f.hashes);assertEquals(1,f.opens);
   }assertEquals(1,f.closes);
   try(var second=f.observation()){second.digest(exe,5000,false);}assertEquals(3,f.hashes);assertEquals(2,f.closes);
  }
 }
 @Test public void sameSizeAndRestoredMtimeCannotHideChangedCtime()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");FileTime before=Files.getLastModifiedTime(exe.toPath());
   try(var observation=f.observation()){observation.digest(exe,5000,false);Thread.sleep(2);Files.write(exe.toPath(),new byte[]{4,3,2,1});Files.setLastModifiedTime(exe.toPath(),before);assertThrows(IOException.class,()->observation.digest(exe,5000,false));assertEquals(1,f.hashes);}
   assertEquals(1,f.closes);
  }
 }
 @Test public void replacementPathCannotInheritHeldFdDigest()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");try(var observation=f.observation()){
   observation.digest(exe,5000,false);Files.move(exe.toPath(),f.dir.resolve("old"));f.file("bun");assertThrows(IOException.class,()->observation.digest(exe,5000,true));assertEquals(1,f.hashes);
  }assertEquals(1,f.closes);}
 }
 @Test public void freshPreSignalDigestRefusesChangedBytesEvenIfMetadataAppearsStable()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");try(var observation=f.observation()){
   observation.digest(exe,5000,false);f.mutateWithoutMetadata=true;assertThrows(IOException.class,()->observation.digest(exe,5000,true));assertEquals(2,f.hashes);
  }}
 }
 @Test public void changesDuringHashRefuseAndCloseUnretainedFd()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");f.mutateDuringHash=true;try(var observation=f.observation()){assertThrows(IOException.class,()->observation.digest(exe,5000,false));}assertEquals(1,f.closes);}
 }
 @Test public void scopeIsBoundedClosesEveryFdAndCannotBeReused()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){var observation=f.observation();for(int n=0;n<32;n++)observation.digest(f.file("f"+n),5000,false);
   assertThrows(IOException.class,()->observation.digest(f.file("too-many"),5000,false));assertEquals(32,f.opens);observation.close();observation.close();assertEquals(32,f.closes);assertThrows(IOException.class,()->observation.digest(f.file("after"),5000,false));
  }
 }
 @Test public void actualNativeSizeDigestBudgetLeavesTimeForExitWithoutHashingPolls()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File exe=f.file("bun");try(RandomAccessFile out=new RandomAccessFile(exe,"rw")){out.setLength(86800440L);}
   try(var observation=f.observation()){
    observation.digest(exe,5000,false);observation.digest(exe,5000,false);observation.digest(exe,5000,false);observation.digest(exe,5000,true);
    assertEquals(2,f.hashes);assertEquals(173600880L,f.bytes);assertTrue(f.clock<5000);
    int[] polls={0};assertTrue(WorkflowSurvivorInventory.awaitResidentExit(42,pid->{assertEquals(42,pid);return ++polls[0]<10;},()->f.clock,ms->f.clock+=ms,5000));assertEquals(2,f.hashes);assertTrue(f.clock<5000);
   }
  }
 }
 @Test public void expiredWaitDoesNotInspectOrSignalAndLiveWaitStaysUnconfirmed()throws Exception {
  long[] clock={5000};assertFalse(WorkflowSurvivorInventory.awaitResidentExit(42,pid->{throw new AssertionError();},()->clock[0],ms->{throw new AssertionError();},5000));
  clock[0]=0;assertFalse(WorkflowSurvivorInventory.awaitResidentExit(42,pid->true,()->clock[0],ms->clock[0]+=ms,5000));assertEquals(5000,clock[0]);
 }
 @Test public void unknownOrReusedActorObservationFailureCannotBecomeAbsence()throws Exception {
  long[] clock={0};IOException failure=new IOException("resident process changed while stopping");
  assertSame(failure,assertThrows(IOException.class,()->WorkflowSurvivorInventory.awaitResidentExit(42,pid->{throw failure;},()->clock[0],ms->clock[0]+=ms,5000)));
 }
 @Test public void retargetedPathAliasCannotCreateANewDigestBaseline()throws Exception {
  try(FilesUnderTest f=new FilesUnderTest()){File first=f.file("first"),second=f.file("second");Path alias=f.dir.resolve("exe-link");Files.createSymbolicLink(alias,first.toPath());
   try(var observation=f.observation()){observation.digest(alias.toFile(),5000,false);Files.delete(alias);Files.createSymbolicLink(alias,second.toPath());assertThrows(IOException.class,()->observation.digest(alias.toFile(),5000,true));assertEquals(1,f.hashes);assertEquals(1,f.opens);}
  }
 }

}

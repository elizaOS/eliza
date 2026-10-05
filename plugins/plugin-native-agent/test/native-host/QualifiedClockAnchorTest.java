package ai.eliza.plugins.agent.updater;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
public final class QualifiedClockAnchorTest {
 static int assertions;static final String PROOF="a".repeat(64);static final long UTC=1790899200000L;
 static final QualifiedClockAnchor.Policy POLICY=new QualifiedClockAnchor.Policy("fixture-only",100000,10000,100,1);
 interface Action {void run()throws Exception;}
 static void check(boolean value){assertions++;if(!value)throw new AssertionError();}
 static void reject(Action action)throws Exception {try{action.run();throw new AssertionError("Expected rejection");}catch(IOException expected){assertions++;}}
 static void sync(Path p)throws IOException {try(FileChannel c=FileChannel.open(p,StandardOpenOption.READ)){c.force(true);}}
 static QualifiedClockAnchor.Sample sample(String boot,long elapsed,long lower,long upper)throws IOException {return new QualifiedClockAnchor.Sample(boot,PROOF,elapsed,lower,upper);}
 static QualifiedClockAnchor open(Path p)throws IOException {return new QualifiedClockAnchor(p,POLICY,QualifiedClockAnchorTest::sync);}
 public static void main(String[] args)throws Exception {
  Path root=Path.of(args[0]);Files.createDirectories(root);
  if(args.length>1){QualifiedClockAnchor clock=new QualifiedClockAnchor(root,POLICY,QualifiedClockAnchorTest::sync,name->{if(name.equals(args[1]))Runtime.getRuntime().halt(71);});clock.acceptAuthenticated(sample("boot-a",100,UTC+100,UTC+1100),"boot-a",100);throw new AssertionError();}
  Path p=root.resolve("normal");reject(()->open(p));QualifiedClockAnchor.initialize(p,QualifiedClockAnchorTest::sync);QualifiedClockAnchor clock=open(p);
  reject(()->clock.read("boot-a",0));reject(()->QualifiedClockAnchor.initialize(p,QualifiedClockAnchorTest::sync));
  clock.acceptAuthenticated(sample("boot-a",0,UTC,UTC+1000),"boot-a",0);
  QualifiedClockAnchor.Interval first=clock.read("boot-a",0);check(first.lower==UTC&&first.upper==UTC+1001);
  QualifiedClockAnchor.Interval later=clock.read("boot-a",10000);check(later.lower==UTC+9998&&later.upper==UTC+11002);
  check(open(p).read("boot-a",10000).lower==later.lower);
  reject(()->clock.read("boot-b",10000));reject(()->clock.read("boot-a",-1));reject(()->clock.read("boot-a",100001));
  reject(()->clock.acceptAuthenticated(sample("boot-b",0,UTC,UTC+1000),"boot-a",0));
  reject(()->clock.acceptAuthenticated(sample("boot-a",200,UTC,UTC+1000),"boot-a",199));
  // Read path never touches storage: temporarily remove it and restore it.
  Path moved=root.resolve("moved");Files.move(p,moved);check(clock.read("boot-a",10000).lower==later.lower);Files.move(moved,p);
  // A narrower overlap is legal. Never use an earlier upper bound as a floor.
  clock.acceptAuthenticated(sample("boot-a",10000,UTC+9900,UTC+10020),"boot-a",10000);
  check(clock.read("boot-a",10000).lower==later.lower);
  reject(()->clock.acceptAuthenticated(sample("boot-a",9999,UTC+9999,UTC+10000),"boot-a",10000));
  reject(()->clock.read("boot-a",10000)); // failed publication/acceptance drops cached authority
  final QualifiedClockAnchor reopened=open(p);
  reject(()->reopened.acceptAuthenticated(sample("boot-b",0,UTC-1000,UTC-1),"boot-b",0));
  QualifiedClockAnchor rebooted=open(p);rebooted.acceptAuthenticated(sample("boot-b",0,UTC+20000,UTC+20100),"boot-b",0);check(rebooted.read("boot-b",0).lower==UTC+20000);
  QualifiedClockAnchor changed=new QualifiedClockAnchor(p,new QualifiedClockAnchor.Policy("new-qualification",100000,10000,100,1),QualifiedClockAnchorTest::sync);
  reject(()->changed.read("boot-b",0));changed.acceptAuthenticated(sample("boot-b",1,UTC+20001,UTC+20101),"boot-b",1);check(changed.read("boot-b",1).lower==UTC+20001);
  QualifiedClockAnchor small=new QualifiedClockAnchor(p,new QualifiedClockAnchor.Policy("tiny",100000,10,100,1),QualifiedClockAnchorTest::sync);
  reject(()->small.acceptAuthenticated(sample("boot-b",2,UTC+20002,UTC+20012),"boot-b",2));
  QualifiedClockAnchor large=new QualifiedClockAnchor(p,new QualifiedClockAnchor.Policy("overflow",QualifiedClockAnchor.MAX,QualifiedClockAnchor.MAX,999999,1),QualifiedClockAnchorTest::sync);
  reject(()->large.acceptAuthenticated(sample("boot-b",0,QualifiedClockAnchor.MAX-10,QualifiedClockAnchor.MAX),"boot-b",20));
  // Corruption/lost state cannot silently initialize or retain in-memory trust.
  byte[] original=Files.readAllBytes(p.resolve("anchor"));Files.write(p.resolve("anchor"),new byte[]{0});reject(()->open(p));Files.write(p.resolve("anchor"),original);
  Files.delete(p.resolve("initialized"));reject(()->open(p));
  for(String boundary:List.of("before-rename","after-rename","after-directory-sync")) {
   Path store=root.resolve(boundary);QualifiedClockAnchor.initialize(store,QualifiedClockAnchorTest::sync);open(store).acceptAuthenticated(sample("boot-a",0,UTC,UTC+1000),"boot-a",0);
   Process child=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin","java").toString(),"-cp",System.getProperty("java.class.path"),QualifiedClockAnchorTest.class.getName(),store.toString(),boundary).inheritIO().start();check(child.waitFor()==71);
   long lower=open(store).read("boot-a",100).lower;check(lower>=UTC+98&&lower<=UTC+100);
  }
  Path expired=root.resolve("expired-refresh");QualifiedClockAnchor.initialize(expired,QualifiedClockAnchorTest::sync);QualifiedClockAnchor renewal=open(expired);renewal.acceptAuthenticated(sample("boot-a",0,UTC,UTC+1000),"boot-a",0);
  reject(()->renewal.read("boot-a",1000000));
  renewal.acceptAuthenticated(sample("boot-a",1000000,UTC+200000,UTC+201000),"boot-a",1000000);check(renewal.read("boot-a",1000000).lower==UTC+200000);
  Path failed=root.resolve("failed-sync");QualifiedClockAnchor.initialize(failed,QualifiedClockAnchorTest::sync);open(failed).acceptAuthenticated(sample("boot-a",0,UTC,UTC+1000),"boot-a",0);
  QualifiedClockAnchor failedWriter=new QualifiedClockAnchor(failed,POLICY,path->{throw new IOException("injected fsync failure");});
  reject(()->failedWriter.acceptAuthenticated(sample("boot-a",100,UTC+100,UTC+1100),"boot-a",100));reject(()->failedWriter.read("boot-a",100));
  check(open(failed).read("boot-a",100).lower==UTC+100);
  // A stale instance reloads the durable floor before accepting another sample.
  QualifiedClockAnchor stale=open(failed);open(failed).acceptAuthenticated(sample("boot-b",0,UTC+10000,UTC+11000),"boot-b",0);
  reject(()->stale.acceptAuthenticated(sample("boot-c",0,UTC,UTC+1000),"boot-c",0));
  Path missing=root.resolve("missing-state");QualifiedClockAnchor.initialize(missing,QualifiedClockAnchorTest::sync);Files.delete(missing.resolve("anchor"));reject(()->open(missing));reject(()->QualifiedClockAnchor.initialize(missing,QualifiedClockAnchorTest::sync));
  Path linkedState=root.resolve("linked-state");QualifiedClockAnchor.initialize(linkedState,QualifiedClockAnchorTest::sync);Files.delete(linkedState.resolve("anchor"));Files.createSymbolicLink(linkedState.resolve("anchor"),failed.resolve("anchor"));reject(()->open(linkedState));
  Path unsafe=root.resolve("unsafe");QualifiedClockAnchor.initialize(unsafe,QualifiedClockAnchorTest::sync);Files.setPosixFilePermissions(unsafe,PosixFilePermissions.fromString("rwxr-xr-x"));reject(()->open(unsafe));
  Path linked=root.resolve("linked");Files.createSymbolicLink(linked,root.resolve("after-rename"));reject(()->open(linked));
  System.out.println("QualifiedClockAnchor: "+assertions+" assertions passed");
 }
}

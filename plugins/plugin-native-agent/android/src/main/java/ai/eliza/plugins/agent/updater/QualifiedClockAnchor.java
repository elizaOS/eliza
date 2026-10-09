package ai.eliza.plugins.agent.updater;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.channels.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.*;

/** Private storage/projection for time already authenticated by a qualified
 * native provider. This class neither authenticates samples nor acquires time.
 * Acceptance is durable; reads are immutable, bounded and free of disk/network IO. */
public class QualifiedClockAnchor {
 public static final long MAX=9007199254740991L;
 public interface Durability { void sync(Path directory)throws IOException; }
 public interface Faults { void boundary(String name)throws IOException; }
 public static final class Policy {
  public final String id; public final long maxAgeMs,maxWidthMs,driftPpm,quantizationMs;
  public Policy(String id,long age,long width,long ppm,long quantization) {
   if(!token(id)||age<=0||age>MAX||width<=0||width>MAX||ppm<0||ppm>=1000000||quantization<0||quantization>width)throw new IllegalArgumentException("Unqualified clock policy");
   this.id=id;maxAgeMs=age;maxWidthMs=width;driftPpm=ppm;quantizationMs=quantization;
  }
  public String identity(){return id+":"+maxAgeMs+":"+maxWidthMs+":"+driftPpm+":"+quantizationMs;}
 }
 public static final class Interval {
  public final long lower,upper;
  public Interval(long lower,long upper)throws IOException {require(lower>0&&upper>=lower&&upper<=MAX,"Invalid time bounds");this.lower=lower;this.upper=upper;}
 }
 public static final class Sample {
  public final String boot,evidence;public final long elapsed;public final Interval bounds;
  // evidence is an opaque audit digest; it is not a signature or a trust proof.
  public Sample(String boot,String evidence,long elapsed,long lower,long upper)throws IOException {
   require(token(boot)&&evidence!=null&&evidence.matches("[a-f0-9]{64}")&&elapsed>=0&&elapsed<=MAX,"Invalid clock sample");
   this.boot=boot;this.evidence=evidence;this.elapsed=elapsed;bounds=new Interval(lower,upper);
  }
 }
 private static final class State {
  public final long floor;final String policy;final Sample sample;
  State(long floor,String policy,Sample sample){this.floor=floor;this.policy=policy;this.sample=sample;}
 }
 private final Path directory;private final Policy policy;private final Durability durability;private final Faults faults;
 private volatile State state;
 public QualifiedClockAnchor(Path directory,Policy policy,Durability durability)throws IOException {this(directory,policy,durability,name->{});}
 public QualifiedClockAnchor(Path directory,Policy policy,Durability durability,Faults faults)throws IOException {
  this.directory=directory.toAbsolutePath().normalize();this.policy=Objects.requireNonNull(policy);this.durability=Objects.requireNonNull(durability);this.faults=Objects.requireNonNull(faults);
  privateDirectory();state=locked(()->load());
 }
 /** Explicit factory initialization only, before enrollment handoff. Never repair
  * missing initialized state or repeat after a partially completed initialization. */
 public static void initialize(Path directory,Durability durability)throws IOException {
  Files.createDirectory(directory,PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
  durability.sync(directory.getParent());
  Path marker=directory.resolve("initialized");
  try(FileChannel out=FileChannel.open(marker,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)) {Files.setPosixFilePermissions(marker,PosixFilePermissions.fromString("rw-------"));write(out,new byte[]{1});out.force(true);}
  durability.sync(directory);
  publish(directory,new State(0,"",null),durability,name->{});
 }
 /** Caller must authenticate source/key policy and bind the observation to this
  * boot/elapsed sample before calling. No renderer or exported IPC entrypoint. */
 public synchronized void acceptAuthenticated(Sample sample,String currentBoot,long currentElapsed)throws IOException {
  require(sample.boot.equals(currentBoot),"Sample belongs to another boot");
  project(sample,currentBoot,currentElapsed); // validates age, drift and uncertainty
  state=null; // an ambiguous failed durable write must invalidate cached authority
  State accepted=locked(()->{
   State previous=load();long floor=previous.floor;
   if(previous.sample!=null&&previous.policy.equals(policy.identity())&&previous.sample.boot.equals(currentBoot)) {
    require(sample.elapsed>=previous.sample.elapsed,"Clock anchor elapsed time regressed");
    // Retain the previous justified lower bound at the new observation, even
    // when that old sample is too old/wide to authorize a current read.
    // Projection stops at the old policy's qualified lifetime.
    floor=Math.max(floor,projectLower(previous.sample,sample.elapsed));
   }
   require(sample.bounds.upper>=floor,"Authenticated time is below historical floor");
   Sample narrowed=new Sample(sample.boot,sample.evidence,sample.elapsed,Math.max(floor,sample.bounds.lower),sample.bounds.upper);
   project(narrowed,currentBoot,currentElapsed);
   State next=new State(narrowed.bounds.lower,policy.identity(),narrowed);
   publish(directory,next,durability,faults);return next;
  });
  state=accepted;
 }
 public Interval read(String currentBoot,long currentElapsed)throws IOException {
  State current=state;require(current!=null&&current.sample!=null,"Fresh authenticated time required");
  require(current.policy.equals(policy.identity()),"Clock qualification changed; fresh sample required");
  return project(current.sample,currentBoot,currentElapsed);
 }
 private Interval project(Sample sample,String boot,long elapsed)throws IOException {
  require(sample.boot.equals(boot),"Reboot requires fresh authenticated time");
  long age=age(sample,elapsed);require(age<=policy.maxAgeMs,"Clock anchor expired");
  long error=error(age),lower=Math.max(sample.bounds.lower,subtract(add(sample.bounds.lower,age),error));
  long upper=add(add(sample.bounds.upper,age),error);
  require(upper-lower<=policy.maxWidthMs,"Clock uncertainty exceeds qualification");return new Interval(lower,upper);
 }
 private long projectLower(Sample sample,long elapsed)throws IOException {
  long age=Math.min(age(sample,elapsed),policy.maxAgeMs);return Math.max(sample.bounds.lower,subtract(add(sample.bounds.lower,age),error(age)));
 }
 private long age(Sample sample,long elapsed)throws IOException {require(elapsed>=sample.elapsed&&elapsed<=MAX,"Elapsed time regressed or overflowed");return elapsed-sample.elapsed;}
 private long error(long age)throws IOException {
  // ceil(age*ppm/1e6), split before multiplication to avoid overflowing long.
  long whole=(age/1000000)*policy.driftPpm;
  long tail=((age%1000000)*policy.driftPpm+999999)/1000000;
  return add(add(whole,tail),policy.quantizationMs);
 }
 private static long add(long a,long b)throws IOException {require(a>=0&&b>=0&&a<=MAX-b,"Clock arithmetic overflow");return a+b;}
 private static long subtract(long a,long b)throws IOException {require(a>=b,"Clock lower bound underflow");return a-b;}
 private void privateDirectory()throws IOException {
  require(Files.isDirectory(directory,LinkOption.NOFOLLOW_LINKS),"Clock store missing or unsafe");
  require(Files.getPosixFilePermissions(directory).equals(PosixFilePermissions.fromString("rwx------")),"Clock store must be private");
 }
 private interface Work {State run()throws IOException;}
 private State locked(Work work)throws IOException {
  privateDirectory();Path lock=directory.resolve("lock");
  try(FileChannel channel=FileChannel.open(lock,StandardOpenOption.CREATE,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)) {
   Files.setPosixFilePermissions(lock,PosixFilePermissions.fromString("rw-------"));
   try(FileLock ignored=channel.lock()){return work.run();}
   catch(OverlappingFileLockException busy){throw new IOException("Clock writer already active",busy);}
  }
 }
 private State load()throws IOException {
  for(String name:new String[]{"initialized","anchor"}) {
   Path file=directory.resolve(name);require(Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)&&Files.size(file)<=4096,"Clock state missing or unsafe");
   require(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")),"Clock state must be private");
  }
  require(Arrays.equals(Files.readAllBytes(directory.resolve("initialized")),new byte[]{1}),"Corrupt clock initialization");
  byte[] bytes=Files.readAllBytes(directory.resolve("anchor"));require(bytes.length>32,"Truncated clock state");
  byte[] payload=Arrays.copyOf(bytes,bytes.length-32),checksum=Arrays.copyOfRange(bytes,bytes.length-32,bytes.length);
  require(MessageDigest.isEqual(hash(payload),checksum),"Corrupt clock state");
  try(DataInputStream in=new DataInputStream(new ByteArrayInputStream(payload))) {
   require(in.readInt()==0x53435431,"Unsupported clock state");long floor=in.readLong();require(floor>=0&&floor<=MAX,"Invalid historical floor");
   String identity=in.readUTF();boolean present=in.readBoolean();Sample sample=null;
   if(present){sample=new Sample(in.readUTF(),in.readUTF(),in.readLong(),in.readLong(),in.readLong());require(floor==sample.bounds.lower&&!identity.isEmpty(),"Invalid clock anchor floor");}
   else require(floor==0&&identity.isEmpty(),"Invalid empty clock anchor");
   require(in.available()==0,"Trailing clock state");return new State(floor,identity,sample);
  }catch(IllegalArgumentException e){throw new IOException("Invalid clock state",e);}
 }
 private static void publish(Path directory,State state,Durability durability,Faults faults)throws IOException {
  ByteArrayOutputStream bytes=new ByteArrayOutputStream();
  try(DataOutputStream out=new DataOutputStream(bytes)) {
   out.writeInt(0x53435431);out.writeLong(state.floor);out.writeUTF(state.policy);out.writeBoolean(state.sample!=null);
   if(state.sample!=null){out.writeUTF(state.sample.boot);out.writeUTF(state.sample.evidence);out.writeLong(state.sample.elapsed);out.writeLong(state.sample.bounds.lower);out.writeLong(state.sample.bounds.upper);}
  }
  byte[] payload=bytes.toByteArray();Path temp=directory.resolve("anchor.tmp");
  try(FileChannel out=FileChannel.open(temp,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)) {
   Files.setPosixFilePermissions(temp,PosixFilePermissions.fromString("rw-------"));write(out,payload);write(out,hash(payload));out.force(true);
  }
  faults.boundary("before-rename");Files.move(temp,directory.resolve("anchor"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
  faults.boundary("after-rename");durability.sync(directory);faults.boundary("after-directory-sync");
 }
 private static void write(FileChannel out,byte[] bytes)throws IOException {ByteBuffer b=ByteBuffer.wrap(bytes);while(b.hasRemaining())out.write(b);}
 private static byte[] hash(byte[] bytes)throws IOException {try{return MessageDigest.getInstance("SHA-256").digest(bytes);}catch(Exception e){throw new IOException(e);}}
 private static boolean token(String value){return value!=null&&value.matches("[A-Za-z0-9._-]{1,128}");}
 private static void require(boolean ok,String message)throws IOException {if(!ok)throw new IOException(message);}
}

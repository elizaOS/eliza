package ai.eliza.plugins.agent.updater;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;

/** Durable start fence for an owner-confirmed package replacement. Contains no credentials.
 * The host supplies Android's authoritative session and installed/executing APK identities.
 * Storage failures deny startup; a timeout or a dismissed confirmation is never cancellation. */
public final class RuntimeUpdatePause {
  public enum Session { ABSENT, PROVEN_UNCOMMITTED, PENDING }
  public static final class Record {
    public final String id, baselineDigest, targetDigest, signer;
    public final int session, boot;
    public final long baselineCode, targetCode;
    public final boolean committing;
    public Record(String id,int session,int boot,long baselineCode,String baselineDigest,long targetCode,String targetDigest,String signer,boolean committing) {
      if(id==null||!id.matches("[a-f0-9-]{36}")||session<0||boot<0||baselineCode<1||targetCode<=baselineCode
          ||!digest(baselineDigest)||!digest(targetDigest)||!digest(signer))throw new IllegalArgumentException("Invalid update ownership");
      this.id=id;this.session=session;this.boot=boot;this.baselineCode=baselineCode;this.baselineDigest=baselineDigest;
      this.targetCode=targetCode;this.targetDigest=targetDigest;this.signer=signer;this.committing=committing;
    }
    private static boolean digest(String value){return value!=null&&value.matches("[a-f0-9]{64}");}
    Record committing(){return new Record(id,session,boot,baselineCode,baselineDigest,targetCode,targetDigest,signer,true);}
  }
  private final Path directory;
  private static final Object LOCK=new Object();
  private static final int MAGIC=0x52555031;
  public RuntimeUpdatePause(Path directory)throws IOException {
    this.directory=directory.toAbsolutePath().normalize();
    Files.createDirectories(this.directory);
    if(!Files.isDirectory(this.directory,LinkOption.NOFOLLOW_LINKS))throw new IOException("Invalid update storage");
  }
  private interface Action<T>{T run()throws IOException;}
  private <T>T locked(Action<T> action)throws IOException {
    synchronized(LOCK){try(FileChannel channel=FileChannel.open(directory.resolve("lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);
        var ignored=channel.lock()){return action.run();}}
  }
  public Record read()throws IOException{return locked(this::load);}
  public void acquire(Record record)throws IOException{Objects.requireNonNull(record);locked(()->{if(load()!=null)throw new IOException("Update already pending");save(record);return null;});}
  public void committing(String id)throws IOException{locked(()->{Record record=load();if(record==null||!record.id.equals(id))throw new IOException("Update owner changed");save(record.committing());return null;});}
  /** liveOwner means the preparing/committing worker still owns the session, even before its commit. */
  public boolean reconcile(String id,long installedCode,String installedDigest,long executingCode,String executingDigest,Session session,boolean liveOwner)throws IOException {
    Objects.requireNonNull(session);
    return locked(()->{
      Record r=load();if(r==null||!r.id.equals(id)||liveOwner)return false;
      boolean successor=installedCode==r.targetCode&&r.targetDigest.equals(installedDigest)&&executingCode==r.targetCode&&r.targetDigest.equals(executingDigest);
      boolean baseline=installedCode==r.baselineCode&&r.baselineDigest.equals(installedDigest)&&executingCode==r.baselineCode&&r.baselineDigest.equals(executingDigest);
      if(!successor&&!(baseline&&session!=Session.PENDING))return false;
      save(null);return true;
    });
  }
  private Record load()throws IOException {
    Path path=directory.resolve("pause");
    final BasicFileAttributes attributes;
    try{attributes=Files.readAttributes(path,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);}
    catch(NoSuchFileException absent){return null;}
    if(!attributes.isRegularFile()||attributes.size()>1024)throw new IOException("Invalid update journal");
    try(DataInputStream in=new DataInputStream(Files.newInputStream(path))){
      if(in.readInt()!=MAGIC)throw new IOException("Invalid update journal");
      Record record=in.readBoolean()?new Record(in.readUTF(),in.readInt(),in.readInt(),in.readLong(),in.readUTF(),in.readLong(),in.readUTF(),in.readUTF(),in.readBoolean()):null;
      if(in.read()!=-1)throw new IOException("Invalid update journal");return record;
    }catch(IllegalArgumentException invalid){throw new IOException("Invalid update journal",invalid);}
  }
  private void save(Record record)throws IOException {
    Path temp=directory.resolve("pause.next");
    try(FileOutputStream stream=new FileOutputStream(temp.toFile());DataOutputStream out=new DataOutputStream(stream)){
      out.writeInt(MAGIC);out.writeBoolean(record!=null);
      if(record!=null){out.writeUTF(record.id);out.writeInt(record.session);out.writeInt(record.boot);out.writeLong(record.baselineCode);out.writeUTF(record.baselineDigest);out.writeLong(record.targetCode);out.writeUTF(record.targetDigest);out.writeUTF(record.signer);out.writeBoolean(record.committing);}
      out.flush();stream.getFD().sync();
    }
    Files.move(temp,directory.resolve("pause"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
    try(FileChannel channel=FileChannel.open(directory,StandardOpenOption.READ)){channel.force(true);}
  }
  /** Configured by the native host before Android initializes providers or services. */
  private static volatile java.util.function.BooleanSupplier startAllowed=()->true;
  public static void configureStartAdmission(java.util.function.BooleanSupplier admission){startAllowed=Objects.requireNonNull(admission);}
  public static void beforeStart(){if(!startAllowed.getAsBoolean())throw new IllegalStateException("App update is pending");}
}

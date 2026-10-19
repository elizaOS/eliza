package ai.elizaos.app;

import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;
import org.json.JSONException;

/** Exclusive startup recovery. Never signals another process or deletes IPC evidence. */
final class IpcStartupRecovery implements Closeable {
    private final File home, lockFile;
    private final RandomAccessFile file;
    private final FileLock lock;
    private final long lockDevice, lockInode;

    private String reviewToken;
    private SortedMap<String,String> reviewed;
    private static final String ARCHIVE_PENDING = "ipc-reviewed-pending-";
    private static final String ARCHIVE_COMPLETE = "ipc-reviewed-";

    static final String RETENTION_LIMIT = "ipc-recovery-retention-limit";
    private static IOException refused(String why) { return new IOException("IPC recovery required: " + why); }
    private static StructStat owned(File value, int kind, int mode) throws Exception {
        StructStat s=Os.lstat(value.getPath());
        if(s.st_uid!=Process.myUid() || (s.st_mode&OsConstants.S_IFMT)!=kind || (s.st_mode&0777)!=mode)throw refused("untrusted owner/type/mode");
        return s;
    }
    private static String bounded(File file,int limit)throws IOException {
        try(FileInputStream in=new FileInputStream(file)){
            ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] chunk=new byte[1024];int n;
            while((n=in.read(chunk))!=-1){if(out.size()+n>limit)throw refused("oversized process identity");out.write(chunk,0,n);}
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
    /** Full process identity; never reduce UID to appId or trust PID existence alone. */
    private static String identity(File proc)throws Exception {
        StructStat before=Os.stat(proc.getPath());
        String stat=bounded(new File(proc,"stat"),16384);int end=stat.lastIndexOf(')');
        if(end<0)throw refused("invalid process identity");String[] fields=stat.substring(end+2).split(" ");
        if(fields.length<20 || !fields[19].matches("[0-9]+"))throw refused("missing process start time");
        String exe=Os.readlink(new File(proc,"exe").getPath());
        if(!exe.startsWith("/") || exe.endsWith(" (deleted)"))throw refused("untrusted process executable");
        String cmd=bounded(new File(proc,"cmdline"),65536);
        if(cmd.isEmpty() || !cmd.endsWith("\0"))throw refused("unreadable process argv");
        StructStat after=Os.stat(proc.getPath());
        if(before.st_uid!=after.st_uid || before.st_ino!=after.st_ino)throw refused("process identity changed");
        return before.st_uid+":"+fields[19]+":"+exe+":"+cmd;
    }
    /** Strong conservative gate: no other process with this full UID is permitted. */
    static void requireSoleUidProcess()throws Exception {
        File self=new File("/proc/"+Process.myPid());String current=identity(self);
        if(Os.stat(self.getPath()).st_uid!=Process.myUid())throw refused("current process UID mismatch");
        File[] processes=new File("/proc").listFiles();if(processes==null || processes.length<20)throw refused("incomplete process inventory");
        for(File proc:processes){if(!proc.getName().matches("[0-9]+") || proc.equals(self))continue;
            StructStat s;
            try{s=Os.stat(proc.getPath());}catch(android.system.ErrnoException error){if(error.errno==OsConstants.ENOENT)continue;throw error;}
            if(s.st_uid==Process.myUid()){
                // Read identity for provenance, but refuse even an unrelated same-UID process.
                identity(proc);throw refused("another same-UID process is alive; preserve it");
            }
        }
        if(!current.equals(identity(self)))throw refused("current process changed during inventory");
    }
    static IpcStartupRecovery acquire(File suppliedHome)throws IOException {
        RandomAccessFile opened=null;FileLock acquired=null;
        try {
            File home=suppliedHome.getCanonicalFile();owned(home,OsConstants.S_IFDIR,0700);
            File file=new File(home,"ipc-supervisor.lock");
            try{Os.lstat(file.getPath());}catch(android.system.ErrnoException absent){
                if(absent.errno!=OsConstants.ENOENT)throw absent;
                java.io.FileDescriptor fd=Os.open(file.getPath(),OsConstants.O_CREAT|OsConstants.O_EXCL|OsConstants.O_WRONLY,0600);Os.close(fd);syncDirectory(home);
            }
            StructStat before=owned(file,OsConstants.S_IFREG,0600);opened=new RandomAccessFile(file,"rw");
            acquired=opened.getChannel().tryLock();if(acquired==null)throw refused("another startup supervisor owns the lock");
            StructStat after=Os.fstat(opened.getFD());if(before.st_dev!=after.st_dev || before.st_ino!=after.st_ino)throw refused("supervisor lock changed");
            return new IpcStartupRecovery(home,file,opened,acquired,after);
        } catch(Exception error){try{if(acquired!=null)acquired.release();if(opened!=null)opened.close();}catch(IOException cleanup){error.addSuppressed(cleanup);}throw error instanceof IOException?(IOException)error:new IOException("IPC recovery lock refused",error);}
    }
    private IpcStartupRecovery(File home,File lockFile,RandomAccessFile file,FileLock lock,StructStat stat){this.home=home;this.lockFile=lockFile;this.file=file;this.lock=lock;lockDevice=stat.st_dev;lockInode=stat.st_ino;}
    synchronized void recover()throws IOException { recover(null,null); }
    synchronized void recover(File workerBun,File workerExecutable)throws IOException {
        reviewToken=null; reviewed=null;
        try {
            if(!lock.isValid())throw refused("supervisor lock lost");StructStat held=owned(lockFile,OsConstants.S_IFREG,0600);
            if(held.st_dev!=lockDevice || held.st_ino!=lockInode)throw refused("supervisor lock replaced");
            File ipc=new File(home,"ipc");StructStat directory=owned(ipc,OsConstants.S_IFDIR,0700);
            if(!ipc.getCanonicalPath().equals(ipc.getPath()))throw refused("IPC directory alias");
            File[] entries=ipc.listFiles();if(entries==null)throw refused("unreadable IPC directory");
            if(workerBun==null||workerExecutable==null)requireSoleUidProcess();else WorkflowSurvivorInventory.requireClassified(home,new File(home,".eliza/smthrs"),workerBun,workerExecutable);
            File[] homeEntries=home.listFiles();if(homeEntries==null)throw refused("unreadable app directory");
            // A crash during explicit archival must not silently free admission slots.
            // Refuse even when the live IPC directory is empty or fewer than eight remain.
            for(File value:homeEntries)if(value.getName().startsWith(ARCHIVE_PENDING))
                throw refused("interrupted evidence archive requires review");
            if(entries.length==0)return;
            int quarantines=0;for(File value:homeEntries)if(value.getName().startsWith("ipc-recovery-"))quarantines++;
            if(quarantines>=8)throw refused(RETENTION_LIMIT + ": eight recovery evidence directories are retained; explicit evidence review is required, waiting will not free a slot");
            Map<String,String> observed=new TreeMap<>();
            for(File entry:entries){String name=entry.getName();int kind;
                if(name.equals("a.sock"))kind=OsConstants.S_IFSOCK;
                else if(name.equals("a.sock.lock")||name.equals("a.sock.generation"))kind=OsConstants.S_IFREG;
                else throw refused("unexpected IPC entry");
                StructStat stat=owned(entry,kind,0600);if(kind==OsConstants.S_IFREG && stat.st_size>4096)throw refused("oversized IPC metadata");observed.put(name,stat.st_dev+":"+stat.st_ino);
            }
            if(workerBun==null||workerExecutable==null)requireSoleUidProcess();else WorkflowSurvivorInventory.requireClassified(home,new File(home,".eliza/smthrs"),workerBun,workerExecutable); // live detached child, launcher or unrelated same-UID process blocks recovery
            for(File entry:entries){StructStat stat=Os.lstat(entry.getPath());if(!observed.get(entry.getName()).equals(stat.st_dev+":"+stat.st_ino))throw refused("IPC entry replaced");}
            File[] again=ipc.listFiles();if(again==null || again.length!=entries.length)throw refused("IPC entries changed");
            StructStat current=owned(ipc,OsConstants.S_IFDIR,0700);if(current.st_dev!=directory.st_dev || current.st_ino!=directory.st_ino)throw refused("IPC directory replaced");
            // Preserve evidence; rename exactly one proven owned directory, never recursively unlink.
            StructStat finalLock=owned(lockFile,OsConstants.S_IFREG,0600);
            if(!lock.isValid() || finalLock.st_dev!=lockDevice || finalLock.st_ino!=lockInode)throw refused("supervisor lock changed before publication");
            File quarantine=new File(home,"ipc-recovery-"+UUID.randomUUID());Os.rename(ipc.getPath(),quarantine.getPath());syncDirectory(home);Os.mkdir(ipc.getPath(),0700);syncDirectory(home);
            owned(ipc,OsConstants.S_IFDIR,0700);
        }catch(Exception error){throw error instanceof IOException?(IOException)error:new IOException("IPC recovery refused",error);}
    }
    /** Only opaque transport metadata is inspected. File contents are never read. */
    private void requireLease() throws Exception {
        StructStat held=owned(lockFile,OsConstants.S_IFREG,0600);
        if(!lock.isValid() || held.st_dev!=lockDevice || held.st_ino!=lockInode)
            throw refused("supervisor lock changed");
        owned(home,OsConstants.S_IFDIR,0700);
        if(!home.getCanonicalPath().equals(home.getPath()))throw refused("home alias");
    }
    private static String metadata(StructStat s, boolean directoryAfterRename) {
        // Rename can change directory ctime; every file timestamp remains bound.
        return s.st_dev+":"+s.st_ino+":"+s.st_uid+":"+s.st_gid+":"+s.st_mode+":"+
            s.st_nlink+":"+s.st_size+":"+s.st_mtim.tv_sec+":"+s.st_mtim.tv_nsec+
            (directoryAfterRename ? "" : ":"+s.st_ctim.tv_sec+":"+s.st_ctim.tv_nsec);
    }
    private SortedMap<String,String> retainedSnapshot() throws Exception {
        requireLease();
        File[] children=home.listFiles();if(children==null)throw refused("unreadable home");
        SortedMap<String,String> result=new TreeMap<>();int count=0;
        for(File child:children) {
            String name=child.getName();
            if(name.startsWith(ARCHIVE_PENDING))throw refused("interrupted archive");
            if(!name.startsWith("ipc-recovery-"))continue;
            if(!name.matches("ipc-recovery-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || ++count>64)
                throw refused("unexpected retained directory");
            StructStat directory=owned(child,OsConstants.S_IFDIR,0700);
            if(!child.getCanonicalPath().equals(child.getPath()))throw refused("retained alias");
            result.put(name,metadata(directory,false));
            File[] entries=child.listFiles();if(entries==null || entries.length>3)throw refused("invalid retained entries");
            for(File entry:entries) {
                String leaf=entry.getName();int kind;
                if(leaf.equals("a.sock"))kind=OsConstants.S_IFSOCK;
                else if(leaf.equals("a.sock.lock") || leaf.equals("a.sock.generation"))kind=OsConstants.S_IFREG;
                else throw refused("unexpected retained entry");
                StructStat stat=owned(entry,kind,0600);
                if(stat.st_nlink!=1 || (kind==OsConstants.S_IFREG && stat.st_size>4096))
                    throw refused("retained links or size");
                result.put(name+"/"+leaf,metadata(stat,false));
            }
            if(!result.get(name).equals(metadata(owned(child,OsConstants.S_IFDIR,0700),false)))
                throw refused("retained directory changed");
        }
        return result;
    }
    private static int directoryCount(Map<String,String> snapshot) {
        int count=0;for(String name:snapshot.keySet())if(name.indexOf('/')<0)count++;return count;
    }
    static JSONObject recoveryResult(String status,int archived,int retained,String reason) throws JSONException {
        JSONObject value=new JSONObject().put("status",status).put("archivedCount",archived).put("retainedCount",retained);
        if(reason!=null)value.put("reason",reason);return value;
    }
    synchronized JSONObject reviewRetained() throws JSONException {
        reviewToken=null;reviewed=null;
        try {
            requireLease();requireSoleUidProcess();
            SortedMap<String,String> before=retainedSnapshot();
            requireSoleUidProcess();SortedMap<String,String> after=retainedSnapshot();
            if(!before.equals(after))return recoveryResult("unavailable",0,0,"records-changed");
            int count=directoryCount(after);
            if(count<8)return recoveryResult("unavailable",0,count,"unsupported-state");
            reviewed=after;reviewToken=UUID.randomUUID().toString();
            return recoveryResult("reviewable",0,count,null).put("reviewToken",reviewToken);
        } catch(Exception refused) {
            return recoveryResult("unavailable",0,0,"inventory-unavailable");
        }
    }
    /** Explicit single-use review. Never touches live IPC, journals or credentials, and never starts work. */
    synchronized JSONObject archiveRetained(String suppliedToken) throws JSONException {
        SortedMap<String,String> expected=reviewed;
        boolean authorized=reviewToken!=null && reviewToken.equals(suppliedToken);
        reviewToken=null;reviewed=null;
        if(!authorized || expected==null)return recoveryResult("unavailable",0,0,"records-changed");
        int total=directoryCount(expected),moved=0;File archive=null;
        try {
            requireLease();requireSoleUidProcess();
            if(!expected.equals(retainedSnapshot()))return recoveryResult("unavailable",0,total,"records-changed");
            // A new private pending directory is a durable interruption marker. A later review
            // refuses it; no automatic continuation or false success is possible after a crash.
            String id=UUID.randomUUID().toString();archive=new File(home,ARCHIVE_PENDING+id);
            Os.mkdir(archive.getPath(),0700);owned(archive,OsConstants.S_IFDIR,0700);syncDirectory(home);
            JSONObject manifest=new JSONObject().put("schemaVersion",1).put("records",new JSONObject(expected));
            java.io.FileDescriptor fd=Os.open(new File(archive,"review.json").getPath(),
                OsConstants.O_CREAT|OsConstants.O_EXCL|OsConstants.O_WRONLY|OsConstants.O_NOFOLLOW,0600);
            try(FileOutputStream out=new FileOutputStream(fd)) {
                out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();
            }
            syncDirectory(archive);
            for(String name:expected.keySet()) {
                if(name.indexOf('/')>=0)continue;
                requireLease();requireSoleUidProcess();
                File source=new File(home,name),target=new File(archive,name);
                verifyRetainedDirectory(source,name,expected,false);
                // Destination is a new private directory; never replace even an unexpected entry.
                try {Os.lstat(target.getPath());throw refused("archive destination exists");}
                catch(android.system.ErrnoException absent){if(absent.errno!=OsConstants.ENOENT)throw absent;}
                Os.rename(source.getPath(),target.getPath());moved++;
                syncDirectory(archive);syncDirectory(home);
                verifyRetainedDirectory(target,name,expected,true);
            }
            requireLease();requireSoleUidProcess();
            for(String name:expected.keySet())if(name.indexOf('/')<0)
                verifyRetainedDirectory(new File(archive,name),name,expected,true);
            // No concurrent new retained records or unreviewed namespace changes may be hidden.
            File[] rootEntries=home.listFiles();if(rootEntries==null)throw refused("unreadable home");
            for(File entry:rootEntries)if(entry.getName().startsWith("ipc-recovery-"))throw refused("new retained records");
            File complete=new File(home,ARCHIVE_COMPLETE+id);
            try{Os.lstat(complete.getPath());throw refused("completed archive exists");}
            catch(android.system.ErrnoException absent){if(absent.errno!=OsConstants.ENOENT)throw absent;}
            JSONObject success=recoveryResult("archived",moved,0,null);
            // LAST filesystem operation: all records and both parents were already fsynced
            // while pending. This atomic rename is the logical commit, not a guarantee that
            // the completed NAME survives power loss. A reverted pending name fails closed.
            Os.rename(archive.getPath(),complete.getPath());
            return success;
        } catch(Exception failure) {
            // All original bytes remain either at their original names or in the pending archive.
            // Once publication begins, require manual inspection even if no source rename completed.
            return recoveryResult(archive==null ? "unavailable" : "partial",moved,total-moved,
                archive==null ? "archive-failed" : "interrupted-archive");
        }
    }
    private static void verifyRetainedDirectory(File dir,String name,Map<String,String> expected,boolean renamed) throws Exception {
        StructStat directory=owned(dir,OsConstants.S_IFDIR,0700);
        if(!dir.getCanonicalPath().equals(dir.getPath()))throw refused("archive directory alias");
        String original=expected.get(name),actual=metadata(directory,renamed);
        if(renamed)original=original.substring(0,original.lastIndexOf(':'));
        if(renamed)original=original.substring(0,original.lastIndexOf(':'));
        if(!actual.equals(original))throw refused("retained directory metadata changed");
        File[] entries=dir.listFiles();if(entries==null)throw refused("archive unreadable");
        int count=0;for(String key:expected.keySet())if(key.startsWith(name+"/"))count++;
        if(entries.length!=count)throw refused("retained entries changed");
        for(File entry:entries) {
            String value=expected.get(name+"/"+entry.getName());
            if(value==null || !value.equals(metadata(Os.lstat(entry.getPath()),false)))
                throw refused("retained entry metadata changed");
        }
    }
    private static void syncDirectory(File directory)throws Exception {
        java.io.FileDescriptor fd=Os.open(directory.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
        try{StructStat stat=Os.fstat(fd);if(!OsConstants.S_ISDIR(stat.st_mode)||stat.st_uid!=Process.myUid())throw refused("untrusted recovery publication directory");Os.fsync(fd);}finally{Os.close(fd);}
    }
    public synchronized void close()throws IOException {try{lock.release();}finally{file.close();}}
}

package ai.elizaos.app;

import android.os.Process;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Exclusive startup recovery. Never signals another process or deletes IPC evidence. */
final class IpcStartupRecovery implements Closeable {
    private final File home, lockFile;
    private final RandomAccessFile file;
    private final FileLock lock;
    private final long lockDevice, lockInode;

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
    private static void requireSoleUidProcess()throws Exception {
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
        try {
            if(!lock.isValid())throw refused("supervisor lock lost");StructStat held=owned(lockFile,OsConstants.S_IFREG,0600);
            if(held.st_dev!=lockDevice || held.st_ino!=lockInode)throw refused("supervisor lock replaced");
            File ipc=new File(home,"ipc");StructStat directory=owned(ipc,OsConstants.S_IFDIR,0700);
            if(!ipc.getCanonicalPath().equals(ipc.getPath()))throw refused("IPC directory alias");
            File[] entries=ipc.listFiles();if(entries==null)throw refused("unreadable IPC directory");
            if(workerBun==null||workerExecutable==null)requireSoleUidProcess();else WorkflowSurvivorInventory.requireClassified(home,new File(home,".eliza/smthrs"),workerBun,workerExecutable);
            if(entries.length==0)return;
            File[] homeEntries=home.listFiles();if(homeEntries==null)throw refused("unreadable app directory");
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
    private static void syncDirectory(File directory)throws Exception {
        java.io.FileDescriptor fd=Os.open(directory.getPath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
        try{StructStat stat=Os.fstat(fd);if(!OsConstants.S_ISDIR(stat.st_mode)||stat.st_uid!=Process.myUid())throw refused("untrusted recovery publication directory");Os.fsync(fd);}finally{Os.close(fd);}
    }
    public synchronized void close()throws IOException {try{lock.release();}finally{file.close();}}
}

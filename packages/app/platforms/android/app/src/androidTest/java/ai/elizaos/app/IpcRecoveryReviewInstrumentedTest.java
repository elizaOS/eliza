package ai.elizaos.app;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.system.Os;
import android.system.StructStat;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real app-private filesystem proof only. Does not qualify the renderer or resident startup. */
public final class IpcRecoveryReviewInstrumentedTest {
    static String hardlinkFixtureOutcome="not-run";
    private File home() throws Exception {
        File value=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir().getCanonicalFile(),"ir-"+UUID.randomUUID().toString().substring(0,8));
        Os.mkdir(value.getPath(),0700);Os.mkdir(new File(value,"ipc").getPath(),0700);return value;
    }
    private void write(File file,String value) throws Exception {
        try(FileOutputStream out=new FileOutputStream(file)){out.write(value.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Os.chmod(file.getPath(),0600);
    }
    private List<File> seed(File home) throws Exception {
        List<File> result=new ArrayList<>();
        for(int i=0;i<8;i++) {
            File dir=new File(home,"ipc-recovery-"+UUID.randomUUID());Os.mkdir(dir.getPath(),0700);
            File liveSocket=new File(home,"ipc/a.sock");
            try(LocalSocket socket=new LocalSocket()) {
                socket.bind(new LocalSocketAddress(liveSocket.getPath(),LocalSocketAddress.Namespace.FILESYSTEM));Os.chmod(liveSocket.getPath(),0600);
            }
            Os.rename(liveSocket.getPath(),new File(dir,"a.sock").getPath());
            write(new File(dir,"a.sock.lock"),"synthetic lock "+i);
            write(new File(dir,"a.sock.generation"),"synthetic opaque transport marker "+i);result.add(dir);
        }
        return result;
    }
    private void removeFixture(File value) {
        File[] children=value.listFiles();if(children!=null)for(File child:children)removeFixture(child);
        assertTrue(value.delete());
    }
    private String token(IpcStartupRecovery recovery) throws Exception {
        JSONObject review=recovery.reviewRetained();assertEquals(review.toString(),"reviewable",review.getString("status"));
        assertEquals(8,review.getInt("retainedCount"));return review.getString("reviewToken");
    }
    @Test public void explicitArchivePreservesEveryByteInodeAndUnrelatedDataAndDoesNotStart() throws Exception {
        File home=home();List<File> dirs=seed(home);File unrelated=new File(home,"synthetic-notes-and-key-sentinel");write(unrelated,"must remain exact");
        Map<String,Long> inodes=new HashMap<>();Map<String,byte[]> bytes=new HashMap<>();
        for(File dir:dirs) {inodes.put(dir.getName(),Os.lstat(dir.getPath()).st_ino);File marker=new File(dir,"a.sock.generation");inodes.put(dir.getName()+"/a.sock.generation",Os.lstat(marker.getPath()).st_ino);bytes.put(dir.getName(),Files.readAllBytes(marker.toPath()));
            inodes.put(dir.getName()+"/a.sock",Os.lstat(new File(dir,"a.sock").getPath()).st_ino);
            inodes.put(dir.getName()+"/a.sock.lock",Os.lstat(new File(dir,"a.sock.lock").getPath()).st_ino);
            bytes.put(dir.getName()+"/a.sock.lock",Files.readAllBytes(new File(dir,"a.sock.lock").toPath()));
        }
        File liveMarker=new File(home,"ipc/a.sock.generation");write(liveMarker,"synthetic current IPC remains untouched by archive");long liveInode=Os.lstat(liveMarker.getPath()).st_ino;
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            assertTrue(assertThrows(IOException.class,()->recovery.recover()).getMessage().contains(IpcStartupRecovery.RETENTION_LIMIT));
            JSONObject result=recovery.archiveRetained(token(recovery));assertEquals("archived",result.getString("status"));assertEquals(8,result.getInt("archivedCount"));assertEquals(0,result.getInt("retainedCount"));
            File[] archives=home.listFiles(f->f.getName().startsWith("ipc-reviewed-")&&!f.getName().startsWith("ipc-reviewed-pending-"));assertNotNull(archives);assertEquals(1,archives.length);
            assertEquals(0700,Os.lstat(archives[0].getPath()).st_mode&0777);
            for(File old:dirs) {assertFalse(old.exists());File retained=new File(archives[0],old.getName()),marker=new File(retained,"a.sock.generation");assertEquals((long)inodes.get(old.getName()),Os.lstat(retained.getPath()).st_ino);assertEquals((long)inodes.get(old.getName()+"/a.sock.generation"),Os.lstat(marker.getPath()).st_ino);assertArrayEquals(bytes.get(old.getName()),Files.readAllBytes(marker.toPath()));
                StructStat socket=Os.lstat(new File(retained,"a.sock").getPath());assertEquals(0600,socket.st_mode&0777);assertEquals(android.system.OsConstants.S_IFSOCK,socket.st_mode&android.system.OsConstants.S_IFMT);
                assertEquals((long)inodes.get(old.getName()+"/a.sock"),socket.st_ino);
                assertArrayEquals(bytes.get(old.getName()+"/a.sock.lock"),Files.readAllBytes(new File(retained,"a.sock.lock").toPath()));
                assertEquals((long)inodes.get(old.getName()+"/a.sock.lock"),Os.lstat(new File(retained,"a.sock.lock").getPath()).st_ino);
            }
            assertEquals("must remain exact",new String(Files.readAllBytes(unrelated.toPath()),StandardCharsets.UTF_8));assertEquals(liveInode,Os.lstat(liveMarker.getPath()).st_ino);
            assertEquals("synthetic current IPC remains untouched by archive",new String(Files.readAllBytes(liveMarker.toPath()),StandardCharsets.UTF_8));
            assertEquals("unavailable",recovery.archiveRetained("stale").getString("status"));
            // A separate, explicit normal recovery can now retire the current IPC namespace.
            recovery.recover();assertEquals(0,Objects.requireNonNull(new File(home,"ipc").list()).length);
            assertEquals(1,Objects.requireNonNull(home.listFiles(f->f.getName().startsWith("ipc-recovery-"))).length);
        } finally {removeFixture(home);}
    }
    @Test public void mutationAfterReviewInvalidatesWholeSetWithoutMovingAnything() throws Exception {
        File home=home();List<File> dirs=seed(home);
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            String token=token(recovery);write(new File(dirs.get(7),"a.sock.generation"),"changed transport marker");
            assertEquals("unavailable",recovery.archiveRetained(token).getString("status"));for(File dir:dirs)assertTrue(dir.isDirectory());
            assertEquals(0,Objects.requireNonNull(home.listFiles(f->f.getName().startsWith("ipc-reviewed-"))).length);
        } finally {removeFixture(home);}
    }
    @Test public void replacementSymlinkIsRefusedAndHardlinkPlatformPolicyIsRecorded() throws Exception {
        File home=home();List<File> dirs=seed(home);
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            File original=new File(dirs.get(0),"a.sock.generation"),replacement=new File(home,"synthetic-replacement");write(replacement,"other synthetic bytes");
            assertTrue(original.delete());Os.symlink(replacement.getPath(),original.getPath());assertEquals("unavailable",recovery.reviewRetained().getString("status"));assertTrue(original.delete());
            try {
                Os.link(replacement.getPath(),original.getPath());
                assertEquals(2,Os.lstat(original.getPath()).st_nlink);
                assertEquals("unavailable",recovery.reviewRetained().getString("status"));
                hardlinkFixtureOutcome="archive-link-count-guard-exercised";
            } catch(android.system.ErrnoException denied) {
                // Some Android SELinux policies prohibit app-created hardlinks. That is a
                // platform protection, NOT execution evidence for our archive link-count guard.
                if(denied.errno!=android.system.OsConstants.EACCES && denied.errno!=android.system.OsConstants.EPERM)throw denied;
                assertFalse(original.exists());assertEquals(1,Os.lstat(replacement.getPath()).st_nlink);
                hardlinkFixtureOutcome="platform-denied-"+(denied.errno==android.system.OsConstants.EACCES ? "EACCES" : "EPERM")+"; archive-link-count-guard-not-exercised";
            }
        } finally {removeFixture(home);}
    }
    @Test public void unexpectedOrOversizeMarkerAndInvalidUuidRefuseWithoutContentsRead() throws Exception {
        File home=home();List<File> dirs=seed(home);
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            File unexpected=new File(dirs.get(0),"not-transport");write(unexpected,"synthetic");assertEquals("unavailable",recovery.reviewRetained().getString("status"));assertTrue(unexpected.delete());
            write(new File(dirs.get(0),"a.sock.generation"),"x".repeat(4097));assertEquals("unavailable",recovery.reviewRetained().getString("status"));write(new File(dirs.get(0),"a.sock.generation"),"synthetic");
            File invalid=new File(home,"ipc-recovery-not-a-uuid");Os.mkdir(invalid.getPath(),0700);assertEquals("unavailable",recovery.reviewRetained().getString("status"));
        } finally {removeFixture(home);}
    }
    @Test public void anyOtherSameUidProcessBlocksReviewAndIsNotStopped() throws Exception {
        File home=home();seed(home);Process peer=new ProcessBuilder("/system/bin/sleep","30").start();
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            assertTrue(peer.isAlive());assertEquals("unavailable",recovery.reviewRetained().getString("status"));assertTrue(peer.isAlive());
        } finally {peer.destroy();peer.waitFor();removeFixture(home);}
    }
    @Test public void tokenCannotSurviveLeaseReplacementOrNormalRecoveryAttempt() throws Exception {
        File home=home();seed(home);String old;
        try(IpcStartupRecovery first=IpcStartupRecovery.acquire(home)){old=token(first);first.recover();assertEquals("unavailable",first.archiveRetained(old).getString("status"));old=token(first);}
        try(IpcStartupRecovery second=IpcStartupRecovery.acquire(home)){assertEquals("unavailable",second.archiveRetained(old).getString("status"));}
        finally {removeFixture(home);}
    }
    @Test public void interruptedArchiveMarkerBlocksNewReviewWithAllRecordsPreserved() throws Exception {
        File home=home();List<File> dirs=seed(home);File pending=new File(home,"ipc-reviewed-pending-"+UUID.randomUUID());Os.mkdir(pending.getPath(),0700);Os.rename(dirs.get(0).getPath(),new File(pending,dirs.get(0).getName()).getPath());
        try {
          try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            assertEquals("unavailable",recovery.reviewRetained().getString("status"));assertTrue(new File(pending,dirs.get(0).getName()).isDirectory());for(int i=1;i<dirs.size();i++)assertTrue(dirs.get(i).isDirectory());
            assertThrows(IOException.class,()->recovery.recover());
            for(int i=1;i<dirs.size();i++)Os.rename(dirs.get(i).getPath(),new File(pending,dirs.get(i).getName()).getPath());
            // Even a crash after the last rename, before final publication, must stay closed.
            assertThrows(IOException.class,()->recovery.recover());
          }
          try(IpcStartupRecovery fresh=IpcStartupRecovery.acquire(home)){assertThrows(IOException.class,()->fresh.recover());}
        } finally {removeFixture(home);}
    }
    @Test public void reviewResponseNeverExposesPathsMetadataOrMarkerContents() throws Exception {
        File home=home();seed(home);
        try(IpcStartupRecovery recovery=IpcStartupRecovery.acquire(home)) {
            JSONObject result=recovery.reviewRetained();assertEquals("reviewable",result.getString("status"));
            Set<String> fields=new HashSet<>();result.keys().forEachRemaining(fields::add);assertEquals(Set.of("status","archivedCount","retainedCount","reviewToken"),fields);
            assertFalse(result.toString().contains(home.getPath()));assertFalse(result.toString().contains("generation"));assertFalse(result.toString().contains("synthetic opaque"));
        } finally {removeFixture(home);}
    }
}

package ai.eliza.plugins.agent.health;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.system.*;
import java.io.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.util.UUID;
/** Disposable SQLite diagnostic only. Never opens user databases/preferences.
 * One private lock bounds concurrent probes and orphan cleanup after app death. */
public final class NativeStorageDiagnostic {
 private NativeStorageDiagnostic() {}
 private static final String OWNED="probe-[a-f0-9]{32}\\.db(?:-journal|-wal|-shm)?";
 public static synchronized void check(Context context,String namespace,long deadline,long maxDatabaseBytes,int maxEntries)throws Exception {
  if(namespace==null||!namespace.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")||maxDatabaseBytes<=0||maxEntries<1)throw new IllegalArgumentException("Explicit diagnostic namespace and positive budgets required");
  checkTime(deadline);
  File directory=new File(context.getNoBackupFilesDir(),namespace);
  if(!directory.exists()&&!directory.mkdir())throw new IOException("Cannot create diagnostic storage");
  checkType(directory,true);Os.chmod(directory.getPath(),0700);
  Path lock=directory.toPath().resolve("lock");
  if(Files.exists(lock,LinkOption.NOFOLLOW_LINKS))checkType(lock.toFile(),false);
  try(FileChannel channel=FileChannel.open(lock,StandardOpenOption.CREATE,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS);FileLock lease=channel.tryLock()){
   if(lease==null)throw new IOException("Storage diagnostic already running");checkType(lock.toFile(),false);
   clean(directory,maxEntries);checkTime(deadline);
   File file=new File(directory,"probe-"+UUID.randomUUID().toString().replace("-","")+".db");
   String nonce=UUID.randomUUID().toString();
   try{
    try(SQLiteDatabase db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.CREATE_IF_NECESSARY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
     checkType(file,false);
     db.execSQL("PRAGMA synchronous=FULL");
     try(Cursor row=db.rawQuery("PRAGMA journal_mode=DELETE",null)){if(!row.moveToFirst()||!"delete".equals(row.getString(0)))throw new IOException("Unexpected diagnostic journal mode");}
     db.execSQL("CREATE TABLE probe(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
     db.beginTransaction();try{db.execSQL("INSERT INTO probe(id,value) VALUES(1,?)",new Object[]{nonce});db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    checkTime(deadline);
    if(file.length()>maxDatabaseBytes)throw new IOException("Diagnostic storage budget");
    try(SQLiteDatabase db=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS)){
     try(Cursor row=db.rawQuery("PRAGMA integrity_check",null)){if(!row.moveToFirst()||!"ok".equals(row.getString(0))||row.moveToNext())throw new IOException("Diagnostic database integrity failed");}
     try(Cursor row=db.rawQuery("SELECT id,value FROM probe",null)){if(!row.moveToFirst()||row.getInt(0)!=1||!nonce.equals(row.getString(1))||row.moveToNext())throw new IOException("Diagnostic readback failed");}
    }
    checkTime(deadline);
   }finally{clean(directory,maxEntries);}
  }
 }
 private static void checkTime(long deadline)throws IOException{if(SystemClock.elapsedRealtime()>=deadline)throw new IOException("Storage diagnostic expired");}
 private static void checkType(File file,boolean directory)throws Exception{
  StructStat stat=Os.lstat(file.getPath());if(stat.st_uid!=android.os.Process.myUid()||(!directory&&stat.st_nlink!=1)||(directory?!OsConstants.S_ISDIR(stat.st_mode):!OsConstants.S_ISREG(stat.st_mode)))throw new IOException("Unsafe diagnostic storage");
 }
 private static void clean(File directory,int maxEntries)throws Exception{
  File[] files=directory.listFiles();if(files==null||files.length>maxEntries)throw new IOException("Diagnostic cleanup budget");
  // Validate the whole namespace before removing any orphan.
  for(File file:files){if(!file.getName().equals("lock")&&!file.getName().matches(OWNED))throw new IOException("Unknown diagnostic entry");checkType(file,false);}
  for(File file:files)if(!file.getName().equals("lock")&&!file.delete())throw new IOException("Cannot clear diagnostic orphan");
 }
}

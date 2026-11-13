package android.util;
import java.io.*;
/** Host filesystem adapter only; Android AtomicFile durability is tested on device. */
public final class AtomicFile {
 public static int corruptNextCommit;
 private final File file;
 public AtomicFile(File file){this.file=file;}
 public File getBaseFile(){return file;}
 public FileInputStream openRead()throws IOException{return new FileInputStream(file);}
 public FileOutputStream startWrite()throws IOException{return new FileOutputStream(file);}
 public void finishWrite(FileOutputStream out)throws IOException{
  out.close();int mode=corruptNextCommit;corruptNextCommit=0;
  if(mode!=0)try(RandomAccessFile bytes=new RandomAccessFile(file,"rw")){
   if(mode==1){bytes.seek(2);int first=bytes.read();bytes.seek(2);bytes.write(first^1);}
   if(mode==2){bytes.seek(bytes.length()-1);int last=bytes.read();bytes.seek(bytes.length()-1);bytes.write(last^1);}
   if(mode==3)bytes.setLength(bytes.length()-1);
   if(mode==4){bytes.seek(bytes.length());bytes.write(0);}
  }
 }
 public void failWrite(FileOutputStream out)throws IOException{out.close();}
 public void delete(){file.delete();}
}

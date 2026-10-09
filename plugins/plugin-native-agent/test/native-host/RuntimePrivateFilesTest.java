package ai.eliza.plugins.agent.runtime.test;
import ai.eliza.plugins.agent.runtime.RuntimePrivateFiles;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

public final class RuntimePrivateFilesTest {
 static int assertions;
 static void check(boolean value) { assertions++; if(!value)throw new AssertionError(); }
 interface Operation {void run()throws Exception;}
 static void rejects(Operation op)throws Exception {try{op.run();throw new AssertionError("Accepted invalid file");}catch(IOException expected){assertions++;}}
 public static void main(String[] args)throws Exception {
  Path root=Files.createDirectories(Path.of(args[0])), file=root.resolve("config");
  check(RuntimePrivateFiles.readOptionalSingleLine(file,1,32)==null);
  byte[] old="old value".getBytes(), replacement="new value".getBytes();
  RuntimePrivateFiles.write(file,old,p->check(p.equals(root.toAbsolutePath())));
  check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")));
  RuntimePrivateFiles.write(file,replacement,p->{});check(Arrays.equals(Files.readAllBytes(file),replacement));
  check(RuntimePrivateFiles.readOptionalSingleLine(file,1,32).equals("new value"));
  rejects(()->RuntimePrivateFiles.readOptionalSingleLine(file,1,4));
  rejects(()->RuntimePrivateFiles.readOptionalSingleLine(file,20,32));
  Files.write(file," first\nsecond ".getBytes());rejects(()->RuntimePrivateFiles.readOptionalSingleLine(file,1,32));
  Files.write(file,new byte[]{(byte)0xff});rejects(()->RuntimePrivateFiles.readOptionalSingleLine(file,1,32));
  Files.write(file," value \n".getBytes());check(RuntimePrivateFiles.readOptionalSingleLine(file,1,32).equals("value"));
  Path victim=root.resolve("victim"), link=root.resolve("link");Files.write(victim,old);Files.createSymbolicLink(link,victim);
  rejects(()->RuntimePrivateFiles.write(link,replacement,p->{}));rejects(()->RuntimePrivateFiles.readOptionalSingleLine(link,1,32));check(Arrays.equals(Files.readAllBytes(victim),old));
  Path dangling=root.resolve("dangling");Files.createSymbolicLink(dangling,root.resolve("absent"));rejects(()->RuntimePrivateFiles.readOptionalSingleLine(dangling,1,32));
  rejects(()->RuntimePrivateFiles.write(root,replacement,p->{}));
  rejects(()->RuntimePrivateFiles.write(file,replacement,p->{throw new IOException("sync failed");}));
  check(Arrays.equals(Files.readAllBytes(file),replacement));
  try(var paths=Files.list(root)){check(paths.noneMatch(p->p.getFileName().toString().startsWith(".runtime-private-")));}
  byte[] a=new byte[65536],b=new byte[65536];Arrays.fill(a,(byte)1);Arrays.fill(b,(byte)2);
  RuntimePrivateFiles.write(file,a,p->{});AtomicReference<Throwable> failure=new AtomicReference<>();
  Thread writer=new Thread(()->{try{for(int i=0;i<100;i++)RuntimePrivateFiles.write(file,i%2==0?b:a,p->{});}catch(Throwable error){failure.set(error);}});writer.start();
  for(int i=0;i<1000;i++){byte[] bytes=Files.readAllBytes(file);check(Arrays.equals(bytes,a)||Arrays.equals(bytes,b));}
  writer.join();check(failure.get()==null);
  System.out.println("RuntimePrivateFiles: "+assertions+" assertions passed");
 }
}

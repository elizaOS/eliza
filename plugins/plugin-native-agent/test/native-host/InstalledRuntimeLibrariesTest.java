package ai.eliza.plugins.agent.runtime.test;
import ai.eliza.plugins.agent.runtime.InstalledRuntimeLibraries;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

public final class InstalledRuntimeLibrariesTest {
 static int assertions;
 static void check(boolean value) { assertions++; if(!value)throw new AssertionError(); }
 interface Operation {void run()throws Exception;}
 static void rejects(Operation op)throws Exception {try{op.run();throw new AssertionError("Accepted invalid alias");}catch(IOException expected){assertions++;}}
 static byte[] elf(int machine){byte[] b=new byte[64];b[0]=0x7f;b[1]='E';b[2]='L';b[3]='F';b[4]=2;b[5]=1;b[18]=(byte)machine;return b;}
 public static void main(String[] args)throws Exception {
  Path root=Files.createDirectories(Path.of(args[0])), first=Files.createDirectory(root.resolve("install one")), second=Files.createDirectory(root.resolve("install two")), aliases=Files.createDirectory(root.resolve("aliases"));
  for(Path install:new Path[]{first,second}) for(String name:new String[]{"libeliza_stdcpp.so","libeliza_gcc_s.so"})Files.write(install.resolve(name),new byte[]{1});
  Path alias=aliases.resolve("libstdc++.so.6");
  Path original=first.resolve("libeliza_stdcpp.so");rejects(()->InstalledRuntimeLibraries.link(original,original));check(Files.isRegularFile(original,LinkOption.NOFOLLOW_LINKS));
  InstalledRuntimeLibraries.prepare(first,aliases);check(Files.readSymbolicLink(alias).equals(first.resolve("libeliza_stdcpp.so")));
  check(InstalledRuntimeLibraries.link(alias,first.resolve("libeliza_stdcpp.so"))==InstalledRuntimeLibraries.LinkResult.UNCHANGED);
  Files.delete(first.resolve("libeliza_stdcpp.so"));
  InstalledRuntimeLibraries.prepare(second,aliases);check(Files.readSymbolicLink(alias).equals(second.resolve("libeliza_stdcpp.so")));check(Files.readAllBytes(alias)[0]==1);
  check(InstalledRuntimeLibraries.link(alias,first.resolve("missing"))==InstalledRuntimeLibraries.LinkResult.MISSING);check(Files.exists(alias));
  Path empty=first.resolve("empty");Files.createFile(empty);check(InstalledRuntimeLibraries.link(alias,empty)==InstalledRuntimeLibraries.LinkResult.MISSING);
  Path ordinary=aliases.resolve("old-copy");Files.write(ordinary,new byte[]{2});check(InstalledRuntimeLibraries.link(ordinary,second.resolve("libeliza_stdcpp.so"))==InstalledRuntimeLibraries.LinkResult.REPLACED);
  Path directory=Files.createDirectory(aliases.resolve("directory"));rejects(()->InstalledRuntimeLibraries.link(directory,second.resolve("libeliza_stdcpp.so")));check(Files.isDirectory(directory));
  Path canvas=second.resolve("libeliza_canvas.so"),legacy=aliases.resolve("skia.linux-arm64-musl.node");Files.write(canvas,new byte[]{3});Files.createSymbolicLink(legacy,root.resolve("missing"));
  Map<String,String> env=new HashMap<>();env.put("UNRELATED","keep");env.put("NAPI_RS_NATIVE_LIBRARY_PATH","stale");
  InstalledRuntimeLibraries.configureCanvas(second,aliases,env);check(env.get("NAPI_RS_NATIVE_LIBRARY_PATH").equals(canvas.toString()));check(!Files.exists(legacy,LinkOption.NOFOLLOW_LINKS));check(env.get("UNRELATED").equals("keep"));
  InstalledRuntimeLibraries.configureCanvas(first,aliases,env);check(!env.containsKey("NAPI_RS_NATIVE_LIBRARY_PATH"));
  Files.createDirectory(legacy);rejects(()->InstalledRuntimeLibraries.configureCanvas(second,aliases,env));check(Files.isDirectory(legacy));
  rejects(()->InstalledRuntimeLibraries.prepare(first,aliases));
  try(var paths=Files.list(aliases)){check(paths.noneMatch(p->p.getFileName().toString().startsWith(".runtime-link-")));}
  for(String abi:new String[]{"arm64-v8a","x86_64"}){
   boolean arm=abi.equals("arm64-v8a");int machine=arm?183:62;String loader="libeliza_ld_musl_"+(arm?"aarch64":"x86_64")+".so";
   Path install=Files.createDirectory(root.resolve("abi "+abi));
   String[] required={loader,"libeliza_bun.so","libeliza_stdcpp.so","libeliza_gcc_s.so"},optional={loader.replace(".so","_real.so"),"libsigsys-handler.so"};
   for(String name:required)Files.write(install.resolve(name),elf(machine));
   check(InstalledRuntimeLibraries.requireAbi(install,abi).equals(install.resolve(loader)));
   for(String name:optional)Files.write(install.resolve(name),elf(machine));
   check(InstalledRuntimeLibraries.requireAbi(install,abi).equals(install.resolve(loader)));
   rejects(()->InstalledRuntimeLibraries.requireAbi(install,arm?"x86_64":"arm64-v8a"));
   for(String name:new String[]{required[0],required[1],required[2],required[3],optional[0],optional[1]}){
    Path file=install.resolve(name);Files.write(file,elf(arm?62:183));rejects(()->InstalledRuntimeLibraries.requireAbi(install,abi));Files.write(file,elf(machine));
   }
   for(int field:new int[]{0,4,5}){byte[] bad=elf(machine);bad[field]=0;Files.write(install.resolve(required[1]),bad);rejects(()->InstalledRuntimeLibraries.requireAbi(install,abi));}
   Files.write(install.resolve(required[1]),new byte[3]);rejects(()->InstalledRuntimeLibraries.requireAbi(install,abi));Files.write(install.resolve(required[1]),elf(machine));
   check(InstalledRuntimeLibraries.requireAbi(install,abi).equals(install.resolve(loader)));
  }
  rejects(()->InstalledRuntimeLibraries.requireAbi(second,"armeabi-v7a"));
  System.out.println("InstalledRuntimeLibraries: "+assertions+" assertions passed");
 }
}

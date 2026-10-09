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
  System.out.println("InstalledRuntimeLibraries: "+assertions+" assertions passed");
 }
}

package ai.eliza.plugins.agent.runtime;
import static org.junit.Assert.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.file.*;
import java.util.*;
import org.junit.Test;

/** Synthetic installed files qualify alias/environment mechanics, not native loading. */
public final class InstalledRuntimeLibrariesInstrumentedTest {
 @Test public void refreshesInstallPathAndClearsOptionalLibrary()throws Exception {
  Path root=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(),"library-links-");
  try {
   Path first=Files.createDirectory(root.resolve("first")),second=Files.createDirectory(root.resolve("second")),aliases=Files.createDirectory(root.resolve("aliases"));
   for(Path dir:new Path[]{first,second})for(String name:new String[]{"libeliza_stdcpp.so","libeliza_gcc_s.so"})Files.write(dir.resolve(name),new byte[]{1});
   InstalledRuntimeLibraries.prepare(first,aliases);
   Path link=aliases.resolve("libstdc++.so.6");
   assertEquals(first.resolve("libeliza_stdcpp.so"),Files.readSymbolicLink(link));
   Files.delete(first.resolve("libeliza_stdcpp.so"));
   InstalledRuntimeLibraries.prepare(second,aliases);
   assertEquals(second.resolve("libeliza_stdcpp.so"),Files.readSymbolicLink(link));assertArrayEquals(new byte[]{1},Files.readAllBytes(link));
   Path canvas=second.resolve("libeliza_canvas.so"),legacy=aliases.resolve("skia.linux-arm64-musl.node");Files.write(canvas,new byte[]{2});Files.createSymbolicLink(legacy,root.resolve("gone"));
   Map<String,String> env=new HashMap<>();InstalledRuntimeLibraries.configureCanvas(second,aliases,env);
   assertEquals(canvas.toString(),env.get("NAPI_RS_NATIVE_LIBRARY_PATH"));assertFalse(Files.exists(legacy,LinkOption.NOFOLLOW_LINKS));
   InstalledRuntimeLibraries.configureCanvas(first,aliases,env);assertFalse(env.containsKey("NAPI_RS_NATIVE_LIBRARY_PATH"));
  }finally{try(var paths=Files.walk(root)){for(Path p:paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList()))Files.deleteIfExists(p);}}
 }
}

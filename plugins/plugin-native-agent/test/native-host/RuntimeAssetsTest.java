package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.RuntimeAssets;
import ai.eliza.plugins.agent.runtime.RuntimeBundleStore;
import java.io.*;
import java.nio.file.*;
import java.util.Arrays;

public final class RuntimeAssetsTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    boolean[] closed = {false};
    byte[] bytes = {1,2,3};
    RuntimeBundleStore.Source source = name -> new ByteArrayInputStream(bytes) {
      @Override public void close() { closed[0] = true; }
    };
    check(Arrays.equals(RuntimeAssets.read(source,"asset",3),bytes)); check(closed[0]);
    closed[0]=false;
    try { RuntimeAssets.read(source,"asset",2); throw new AssertionError(); } catch(IOException expected) { checks++; }
    check(closed[0]);
    try { RuntimeAssets.read(source,"asset",0); throw new AssertionError(); } catch(IllegalArgumentException expected) { checks++; }
    RuntimeBundleStore.Source zeroRead = name -> new ByteArrayInputStream(bytes) {
      private boolean first=true;
      @Override public int read(byte[] target,int offset,int length) { if(first){first=false;return 0;}return super.read(target,offset,length); }
    };
    check(Arrays.equals(RuntimeAssets.read(zeroRead,"asset",3),bytes));
    Path root=Files.createTempDirectory("runtime-assets-");
    try {
      Files.write(root.resolve("libtest.so"),bytes);
      check(RuntimeAssets.available(source,root,new String[]{"libtest.so"},new String[]{"asset"}));
      check(!RuntimeAssets.available(source,root,new String[]{"missing.so"},new String[]{"asset"}));
      check(!RuntimeAssets.available(name->{throw new IOException("missing");},root,new String[]{},new String[]{"missing"}));
      Path output=root.resolve("releases");
      closed[0]=false;
      RuntimeBundleStore.Source large = name -> new ByteArrayInputStream(new byte[2*1024*1024+1]) {
        @Override public void close(){closed[0]=true;}
      };
      try {RuntimeBundleStore.prepareFromAsset(output,"inventory",large,root,path->{},"eliza-runtime-v1");throw new AssertionError();}
      catch(IOException expected){checks++;}
      check(closed[0]);check(!Files.exists(output));
      try {RuntimeBundleStore.prepareFromAsset(output,"inventory",source,root,path->{},"eliza-runtime-v1");throw new AssertionError();}
      catch(IOException expected){checks++;}
      check(!Files.exists(output));
    } finally { Files.deleteIfExists(root.resolve("libtest.so")); Files.delete(root); }
    System.out.println("RuntimeAssetsTest: "+checks+" checks passed");
  }
}

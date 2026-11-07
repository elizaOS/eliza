package ai.elizaos.app;
import java.io.IOException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class AndroidBunTargetTest {
 @Test public void onlySignedManifestTargetAndExplicitNativeAbiAreAdmitted()throws Exception {
  JSONObject legacy=new JSONObject().put("schema","eliza.android_agent_runtime_provenance.v1");
  assertEquals("linux-musl",AndroidBunTarget.fromManifest(legacy,"arm64-v8a"));
  JSONObject nativeManifest=new JSONObject(legacy.toString()).put("bun",new JSONObject().put("target","android").put("architectures",new org.json.JSONArray().put("arm64-v8a")));
  assertEquals("android",AndroidBunTarget.fromManifest(nativeManifest,"arm64-v8a"));
  assertThrows(IOException.class,()->AndroidBunTarget.fromManifest(nativeManifest,"x86_64"));
  assertThrows(IOException.class,()->AndroidBunTarget.fromManifest(new JSONObject(),"arm64-v8a"));
  assertThrows(IOException.class,()->AndroidBunTarget.fromManifest(new JSONObject(legacy.toString()).put("bun",new JSONObject().put("target","other")),"arm64-v8a"));
 }
}

package ai.elizaos.app;

import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Target selection comes from signed APK provenance, never renderer/env input. */
final class AndroidBunTarget {
 static final String MUSL="linux-musl", ANDROID="android";
 static String fromManifest(JSONObject manifest,String abi)throws IOException {
  if(!"eliza.android_agent_runtime_provenance.v1".equals(manifest.optString("schema")))
   throw new IOException("Unsupported Android runtime provenance");
  JSONObject bun=manifest.optJSONObject("bun");
  String target=bun==null?MUSL:bun.optString("target",MUSL);
  if(!MUSL.equals(target)&&!ANDROID.equals(target))throw new IOException("Unsupported Android Bun target");
  if(ANDROID.equals(target)) {
   JSONArray architectures=bun.optJSONArray("architectures");boolean found=false;
   if(architectures!=null)for(int i=0;i<architectures.length();i++)if(abi.equals(architectures.optString(i)))found=true;
   if(!found)throw new IOException("Native Android Bun ABI is not admitted");
  }
  return target;
 }
}

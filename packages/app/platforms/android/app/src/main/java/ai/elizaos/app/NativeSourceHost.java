package ai.elizaos.app;

import org.json.JSONObject;

/** Native product-owned, read-only source callback. No renderer or HTTP configuration. */
public final class NativeSourceHost {
 public interface Reader {JSONObject read(JSONObject request)throws Exception;}
 private static volatile Reader reader;
 private NativeSourceHost() {}
 public static synchronized void configure(Reader next){if(next==null)throw new IllegalArgumentException("Native source reader required");if(reader!=null&&reader!=next)throw new IllegalStateException("Native source host already configured");reader=next;}
 static JSONObject read(JSONObject request,int peerUid,int appUid)throws Exception {
  if(peerUid!=appUid)throw new SecurityException("Native source peer unavailable");
  Reader current=reader;if(current==null)throw new SecurityException("Native source host unavailable");
  return current.read(new JSONObject(request.toString()));
 }
}

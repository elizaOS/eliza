package ai.elizaos.app;

import org.json.JSONObject;

/** Native product-owned, read-only source callback. No renderer or HTTP configuration. */
public final class NativeSourceHost {
 public interface Reader {JSONObject read(JSONObject request)throws Exception;}
 static final class OwnerReminderContextUnavailable extends UnsupportedOperationException {}
 public interface OwnerReminderContextReader {JSONObject read()throws Exception;}
 private static volatile Reader reader;
 private static volatile OwnerReminderContextReader ownerReminderContext;
 private NativeSourceHost() {}
 public static synchronized void configure(Reader next){if(next==null)throw new IllegalArgumentException("Native source reader required");if(reader!=null&&reader!=next)throw new IllegalStateException("Native source host already configured");reader=next;}
 /** Trusted Application composition only. No renderer/HTTP configure path. */
 public static synchronized void configureOwnerReminderContext(OwnerReminderContextReader next){if(next==null)throw new IllegalArgumentException("Native owner context required");if(ownerReminderContext!=null&&ownerReminderContext!=next)throw new IllegalStateException("Native owner context already configured");ownerReminderContext=next;}
 static JSONObject readOwnerReminderContext(int peerUid,int appUid)throws Exception {
  if(peerUid!=appUid)throw new SecurityException("Native owner peer unavailable");
  OwnerReminderContextReader current=ownerReminderContext;
  if(current==null)throw new OwnerReminderContextUnavailable();
  JSONObject value=current.read();
  String[] fields={"subjectUserId","agentId","installationId","enrollmentId","accountRef","environment","sessionGeneration"};
  if(value==null||value.length()!=fields.length+1||!(value.opt("protocol") instanceof Number)||((Number)value.opt("protocol")).doubleValue()!=1)throw new SecurityException("Invalid native owner context");
  JSONObject result=new JSONObject().put("protocol",1);
  for(String field:fields){Object item=value.opt(field);if(!(item instanceof String)||((String)item).trim().isEmpty()||((String)item).length()>1024)throw new SecurityException("Invalid native owner context");result.put(field,item);}
  return result;
 }
 static JSONObject read(JSONObject request,int peerUid,int appUid)throws Exception {
  if(peerUid!=appUid)throw new SecurityException("Native source peer unavailable");
  Reader current=reader;if(current==null)throw new SecurityException("Native source host unavailable");
  return current.read(new JSONObject(request.toString()));
 }
}

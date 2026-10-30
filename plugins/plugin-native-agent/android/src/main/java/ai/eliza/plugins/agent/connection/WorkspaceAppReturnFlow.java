package ai.eliza.plugins.agent.connection;

import ai.eliza.plugins.agent.runtime.NativeProviderAdmission;

import java.util.Set;
import org.json.JSONObject;
import org.json.JSONTokener;

/** One pending Workspace return in the existing native store; never writes credentials.
 * The host invalidates pending state on logout or credential-authority replacement. UI session IDs are not durable identity. */
public final class WorkspaceAppReturnFlow {
 public interface Store {
  String credential() throws Exception;
  String pending() throws Exception;
  boolean comparePending(String expected,String value) throws Exception;
 }
 private final Store store;
 private final WorkspaceAppReturn policy;
 public WorkspaceAppReturnFlow(WorkspaceAppReturn policy,Store store) {
  if(policy==null||store==null)throw new IllegalArgumentException("Workspace store required");this.store=store;this.policy=policy;
 }
 public static WorkspaceAppReturn.Binding binding(String environment,String userId,String organizationId,String credentialId,String rawCredential,long now) {
  try {
   JSONObject saved=object(rawCredential);
   if(!credentialId.equals(saved.getString("credentialId")))throw new IllegalArgumentException();
   return new WorkspaceAppReturn.Binding(environment,userId,organizationId,credentialId,NativeProviderAdmission.cloudCredentialFingerprint(rawCredential,now));
  }catch(Exception invalid){throw new IllegalArgumentException("Current Workspace credential required");}
 }
 private static JSONObject object(String raw) throws Exception {
  if(raw==null||raw.length()>262144)throw new IllegalArgumentException();
  JSONTokener parser=new JSONTokener(raw);Object value=parser.nextValue();
  if(!(value instanceof JSONObject)||parser.nextClean()!=0)throw new IllegalArgumentException();
  return (JSONObject)value;
 }
 private static WorkspaceAppReturn.Pending pending(String raw) {
  try {
   JSONObject value=object(raw);
   Set<String> expected=Set.of("environment","userId","organizationId","credentialId","credentialHash","state","createdAt");
   if(value.length()!=expected.size())return null;
   for(java.util.Iterator<String> keys=value.keys();keys.hasNext();)if(!expected.contains(keys.next()))return null;
   Object time=value.get("createdAt");if(!(time instanceof Number))return null;
   double decimal=((Number)time).doubleValue();long instant=((Number)time).longValue();
   if(!Double.isFinite(decimal)||decimal!=instant)return null;
   WorkspaceAppReturn.Binding owner=new WorkspaceAppReturn.Binding(value.getString("environment"),value.getString("userId"),value.getString("organizationId"),value.getString("credentialId"),value.getString("credentialHash"));
   return new WorkspaceAppReturn.Pending(owner,value.getString("state"),instant);
  }catch(Exception invalid){return null;}
 }
 private boolean current(WorkspaceAppReturn.Binding binding,long now) throws Exception {
  String raw=store.credential();
  if(binding==null||raw==null)return false;
  try {
   object(raw);
   return binding.credentialHash.equals(NativeProviderAdmission.cloudCredentialFingerprint(raw,now));
  }catch(Exception invalid){return false;}
 }
 public String prepare(WorkspaceAppReturn.Binding binding,String nonce,long now) throws Exception {
  WorkspaceAppReturn.Pending next=new WorkspaceAppReturn.Pending(binding,nonce,now);
  if(!current(binding,now))throw new IllegalStateException("Workspace account changed");
  String before=store.pending();
  JSONObject value=new JSONObject().put("environment",binding.environment).put("userId",binding.userId).put("organizationId",binding.organizationId)
   .put("credentialId",binding.credentialId).put("credentialHash",binding.credentialHash).put("state",next.nonce).put("createdAt",now);
  String encoded=value.toString();
  if(!store.comparePending(before,encoded))throw new IllegalStateException("Workspace attempt changed");
  if(!current(binding,now)) {
   store.comparePending(encoded,null);
   throw new IllegalStateException("Workspace account changed");
  }
  return policy.redirect(nonce);
 }
 /** Capture eligibility only; never consumes or replaces an incoming return. */
 public boolean captureAllowed(String url,long now) throws Exception {
  WorkspaceAppReturn.Callback callback=policy.parse(url);
  if(callback==null)return false;
  WorkspaceAppReturn.Pending retained=pending(store.pending());
  return retained!=null&&WorkspaceAppReturn.accepts(retained,retained.binding,callback,now)&&current(retained.binding,now);
 }
 /** Consume before the caller performs its canonical connection/account readback. */
 public WorkspaceAppReturn.Callback consume(WorkspaceAppReturn.Binding binding,String url,long now) throws Exception {
  WorkspaceAppReturn.Callback callback=policy.parse(url);
  if(callback==null)return null;
  String raw=store.pending();WorkspaceAppReturn.Pending retained=pending(raw);
  if(!WorkspaceAppReturn.accepts(retained,binding,callback,now)||!current(binding,now))return null;
  if(!store.comparePending(raw,null)||!current(binding,now))return null;
  return callback;
 }
 public void cancel(String state) throws Exception {
  if(state==null||!state.matches("[A-Za-z0-9_-]{43}"))return;
  String raw=store.pending();WorkspaceAppReturn.Pending retained=pending(raw);
  if(retained!=null&&retained.nonce.equals(state))store.comparePending(raw,null);
 }
}

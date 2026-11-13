package ai.eliza.plugins.agent.connection;

import java.net.URI;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Pure Workspace return contract. The native host owns storage, CAS and account readback. */
public final class WorkspaceAppReturn {
 public static final long TTL=600000L;
 private final String callback;
 private final URI callbackUri;
 public WorkspaceAppReturn(String callback) {
  try {
   URI uri=new URI(callback);
   if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getPort()!=-1||uri.getRawUserInfo()!=null
     ||uri.getRawPath()==null||!uri.getRawPath().startsWith("/")||uri.getRawQuery()!=null||uri.getRawFragment()!=null)
    throw new IllegalArgumentException("Invalid Workspace callback");
   this.callback=callback;this.callbackUri=uri;
  }catch(Exception invalid){throw new IllegalArgumentException("Invalid Workspace callback");}
 }
 public String redirect(String state) { return callback+"?state="+nonce(state); }
 /** Selected is an explicit OS user choice, not proof of production domain verification. */
 public static String association(boolean enabled,boolean ownCallback,boolean verified,boolean selected){
  return !enabled||!ownCallback?null:verified?"verified":selected?"user-selected":null;
 }


 private static String uuid(String value) {
  if(value==null||!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))throw new IllegalArgumentException("Invalid Workspace identity");
  return value;
 }
 private static String nonce(String value) {
  if(value==null||!value.matches("[A-Za-z0-9_-]{43}"))throw new IllegalArgumentException("Invalid Workspace nonce");
  return value;
 }

 public static final class Binding {
  public final String environment,userId,organizationId,credentialId,credentialHash;
  public Binding(String environment,String userId,String organizationId,String credentialId,String credentialHash) {
   if(!"production".equals(environment))throw new IllegalArgumentException("Unsupported Workspace environment");
   if(credentialHash==null||!credentialHash.matches("[0-9a-fA-F]{64}"))throw new IllegalArgumentException("Invalid Workspace credential hash");
   this.environment=environment;this.userId=uuid(userId);this.organizationId=uuid(organizationId);
   this.credentialId=uuid(credentialId);this.credentialHash=credentialHash.toLowerCase(Locale.ROOT);
  }
  public boolean same(Binding other) {
   return other!=null&&environment.equals(other.environment)&&userId.equals(other.userId)&&organizationId.equals(other.organizationId)
    &&credentialId.equals(other.credentialId)&&credentialHash.equals(other.credentialHash);
  }
 }
 public static final class Pending {
  public final Binding binding;
  public final String nonce;
  public final long createdAt;
  public Pending(Binding binding,String nonce,long createdAt) {
   if(binding==null)throw new IllegalArgumentException("Workspace binding required");this.binding=binding;this.nonce=nonce(nonce);
   if(createdAt<0)throw new IllegalArgumentException("Invalid Workspace creation time");this.createdAt=createdAt;
  }
 }
 public static final class Callback {
  public final String state,result,connectionId;
  public Callback(String state,String result,String connectionId) {
   this.state=nonce(state);
   if(!"connected".equals(result)&&!"denied".equals(result)&&!"failed".equals(result))throw new IllegalArgumentException("Invalid Workspace result");
   if("connected".equals(result)) {
    if(connectionId==null||!connectionId.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid Workspace connection");
   } else if(connectionId!=null)throw new IllegalArgumentException("Unexpected Workspace connection");
   this.result=result;this.connectionId=connectionId;
  }
 }

 /** Parse literal contract fields only; percent encoding is not an alternate spelling. */
 public Callback parse(String value) {
  if(value==null||value.length()>512||!value.startsWith(callback+"#"))return null;
  try {
   URI uri=new URI(value);
   if(!"https".equals(uri.getScheme())||!callbackUri.getHost().equals(uri.getHost())||uri.getPort()!=-1||uri.getRawUserInfo()!=null
     ||!callbackUri.getRawPath().equals(uri.getRawPath())||uri.getRawQuery()!=null||uri.getRawFragment()==null)return null;
   Map<String,String> fields=new HashMap<>();
   for(String part:uri.getRawFragment().split("&",-1)) {
    int equal=part.indexOf('=');if(equal<=0||equal!=part.lastIndexOf('='))return null;
    String key=part.substring(0,equal),text=part.substring(equal+1);
    if(!key.equals("state")&&!key.equals("result")&&!key.equals("connectionId"))return null;
    if(fields.put(key,text)!=null)return null;
   }
   String result=fields.get("result");
   if(fields.size()!=("connected".equals(result)?3:2))return null;
   return new Callback(fields.get("state"),result,fields.get("connectionId"));
  }catch(Exception invalid){return null;}
 }

 /** Pure admission only: the caller must atomically consume matching pending state before use. */
 public static boolean accepts(Pending pending,Binding current,Callback callback,long now) {
  return pending!=null&&callback!=null&&pending.binding.same(current)&&pending.nonce.equals(callback.state)
   &&now>=pending.createdAt&&now-pending.createdAt<TTL;
 }
}

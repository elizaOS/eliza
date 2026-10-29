package ai.eliza.plugins.notifications;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native owner admission and narrow managed-service reads for a host's background new-mail check, using
 * the host's existing encrypted Eliza Cloud key. It drives {@link MailHistoryReconciliation} against the
 * Cloud owner Gmail history route and posts content-free notices through the host's poster.
 *
 * <p>Android-free so its fences are testable on a JVM. The host supplies its storage, credential, reset and
 * identity ports ({@link Host}), a periodic scheduler (WorkManager on Android), its notice poster and the
 * fixed Cloud API authority.
 *
 * <p>Admission is bound to the signed-in Cloud credential and the owner the foreground UI names, never to
 * the agent's inference provider: the check only reads Cloud Gmail routes with the Cloud key, verifies the
 * Cloud owner and the read grant remotely before every page, and pins the exact credential bytes. A host
 * whose agent infers through another provider can therefore still enable it.
 */
public final class MailBackgroundDelivery {
 /** Host storage, credential and identity ports. All calls happen under {@link #lock()}. */
 public interface Host {
  /** One process-wide lock shared with every writer of the credential and state slots. */
  Object lock();
  /** The state slot ({@link MailHistoryReconciliation} format), or null. Name is migration-sensitive. */
  String readState()throws Exception;
  void writeState(String value)throws Exception;
  void removeState()throws Exception;
  /** Raw JSON of the signed-in Cloud credential (credentialId, token, optional expiresAt ms), or null. */
  String readCredential()throws Exception;
  /** True while a host data reset is pending: nothing is admitted or written. */
  boolean resetPending()throws Exception;
  /** userId/organizationId verified from the Cloud user response's data object; throws when unverifiable. */
  JSONObject verifiedIdentity(JSONObject userData)throws Exception;
 }
 /** Ordinary constrained background work for the current selection generation. */
 public interface Scheduler {void schedule(String generation);void cancel();}
 /** The host's notice poster; cancelAll withdraws every notice this module posted. */
 public interface Notices extends MailHistoryReconciliation.Poster {void cancelAll();}
 /** Opens a connection to a constructed route of the fixed authority. Replaced only by tests. */
 public interface Connections {HttpURLConnection open(URL url)throws Exception;}
 /** Immutable host inputs. */
 public static final class Config {
  final String apiBase,environment,readCapability;final int pagesPerJob;
  /**
   * @param apiBase fixed Cloud API authority without a trailing slash, e.g. "https://api.example"
   * @param environment the Cloud environment the credential belongs to (owner account reference)
   * @param readCapability the granted capability that admits background reads, e.g. "google.gmail.triage"
   * @param pagesPerJob bound on history pages per job; continuations remain durable for the next job
   */
  public Config(String apiBase,String environment,String readCapability,int pagesPerJob){
   if(apiBase==null||!apiBase.matches("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?")||environment==null||environment.isBlank()||readCapability==null||readCapability.isBlank()||pagesPerJob<1||pagesPerJob>16)throw new IllegalArgumentException("Invalid mail delivery configuration");
   this.apiBase=apiBase;this.environment=environment;this.readCapability=readCapability;this.pagesPerJob=pagesPerJob;
  }
 }
 public static final String USER_ROUTE="/api/v1/user",ACCOUNTS_ROUTE="/api/v1/eliza/google/accounts?side=owner",HISTORY_ROUTE="/api/v1/eliza/google/gmail/history?grantId=";
 private static final String[] SAME_SELECTION={"grantId","credentialDigest","accountRef"};
 private final Host host;private final Scheduler scheduler;private final Notices poster;private final Config config;private final Connections connections;
 private final AtomicLong attempts=new AtomicLong();private long admittedAttempt;

 public MailBackgroundDelivery(Host host,Scheduler scheduler,Notices poster,Config config){this(host,scheduler,poster,config,url->(HttpURLConnection)url.openConnection());}
 public MailBackgroundDelivery(Host host,Scheduler scheduler,Notices poster,Config config,Connections connections){
  this.host=Objects.requireNonNull(host);this.scheduler=Objects.requireNonNull(scheduler);this.poster=Objects.requireNonNull(poster);this.config=Objects.requireNonNull(config);this.connections=Objects.requireNonNull(connections);
 }
 private JSONObject saved()throws Exception{String raw=host.readState();return raw==null?null:new JSONObject(raw);}
 /** Starts a foreground selection attempt; a later attempt supersedes it. */
 public long begin(){synchronized(host.lock()){return attempts.incrementAndGet();}}
 private static String cloudId(String value){if(value==null||!value.matches("[A-Za-z0-9_-]{1,128}"))throw new SecurityException("Cloud owner required");return value;}
 private String accountRef(String user,String organization){return new JSONArray().put("cloud").put(config.environment).put(user).put(organization).toString();}
 private String credential(String credentialId)throws Exception{
  if(host.resetPending())throw new SecurityException("Reset pending");
  String raw=host.readCredential();if(raw==null)throw new SecurityException("Cloud sign-in required");
  if(credentialId==null||!credentialId.equals(new JSONObject(raw).optString("credentialId",null)))throw new SecurityException("Cloud credential changed");
  return raw;
 }
 private JSONObject admission(String credentialId,String grant,String user,String organization)throws Exception{
  String raw=credential(credentialId),userId=cloudId(user),organizationId=cloudId(organization);
  return new JSONObject().put("generation",UUID.randomUUID().toString()).put("credentialId",credentialId).put("credentialDigest",MailHistoryReconciliation.hash(raw)).put("accountRef",accountRef(userId,organizationId)).put("userId",userId).put("organizationId",organizationId).put("grantId",MailHistoryReconciliation.id(grant));
 }
 /** The local half of the owner fence: same credential bytes, no pending reset. The remote half is verify(). */
 private void admitted(JSONObject binding)throws Exception{
  String raw=credential(binding.getString("credentialId"));
  if(!MailHistoryReconciliation.hash(raw).equals(binding.getString("credentialDigest"))||!accountRef(binding.getString("userId"),binding.getString("organizationId")).equals(binding.getString("accountRef")))throw new SecurityException("Mail owner changed");
 }
 private void current(JSONObject binding)throws Exception{if(admittedAttempt!=attempts.get())throw new SecurityException("Mail selection being revalidated");admitted(binding);JSONObject s=saved();if(s==null||!s.getJSONObject("binding").getString("generation").equals(binding.getString("generation")))throw new SecurityException("Mail selection changed");}
 private MailHistoryReconciliation engine(JSONObject binding){return new MailHistoryReconciliation(new MailHistoryReconciliation.Store(){public String read()throws Exception{return host.readState();}public void write(String value)throws Exception{current(binding);host.writeState(value);}},()->current(binding),poster);}
 /**
  * Called only from a foreground account selection. The renderer names the Cloud credential, the read grant
  * and the owner it shows; native independently verifies that owner and grant with the Cloud service before
  * saving anything. Re-selecting the same owner, credential and grant keeps the durable cursor.
  */
 public JSONObject configure(long attempt,String credentialId,String grant,String userId,String organizationId)throws Exception{
  JSONObject binding;synchronized(host.lock()){binding=admission(credentialId,grant,userId,organizationId);}
  MailHistoryReconciliation.Guard guard=()->{if(attempts.get()!=attempt)throw new SecurityException("Mail selection superseded");synchronized(host.lock()){admitted(binding);}};
  verify(binding,guard);
  synchronized(host.lock()){
   guard.check();JSONObject previous=saved();
   if(previous!=null){JSONObject before=previous.getJSONObject("binding");boolean same=true;for(String field:SAME_SELECTION)same&=before.optString(field).equals(binding.getString(field));if(same){admittedAttempt=attempt;scheduler.schedule(before.getString("generation"));return engine(before).status();}}
   poster.cancelAll();scheduler.cancel();host.writeState(MailHistoryReconciliation.initial(binding).toString());admittedAttempt=attempt;scheduler.schedule(binding.getString("generation"));return engine(binding).status();
  }
 }
 /** Retires the selection (all of it, or only when it is for this grant), its schedule and its notices. */
 public void withdraw(String grant)throws Exception{synchronized(host.lock()){JSONObject s=saved();if(grant!=null&&s!=null&&!grant.equals(s.getJSONObject("binding").getString("grantId")))return;admittedAttempt=begin();host.removeState();poster.cancelAll();scheduler.cancel();}}
 /** Host resume: reschedules a still-current selection, retires a stale one. */
 public void resume(){try{synchronized(host.lock()){if(admittedAttempt!=attempts.get())return;JSONObject s=saved();if(s==null)return;JSONObject binding=s.getJSONObject("binding");current(binding);scheduler.schedule(binding.getString("generation"));}}catch(Exception stale){try{withdraw(null);}catch(Exception ignored){/* Existing callback guards still fail closed. */}}}
 public JSONObject status()throws Exception{synchronized(host.lock()){JSONObject s=saved();if(s==null)return new JSONObject().put("status","disabled");return engine(s.getJSONObject("binding")).status().put("notificationsAllowed",poster.allowed());}}
 private static final class HttpFailure extends IOException {final int status;HttpFailure(int status){super("Mail service unavailable");this.status=status;}}
 private JSONObject get(JSONObject binding,String path,MailHistoryReconciliation.Guard guard)throws Exception{
  // Constructed paths only, with a fixed service authority. No remote-agent host or redirect.
  if(!(path.equals(USER_ROUTE)||path.equals(ACCOUNTS_ROUTE)||path.startsWith(HISTORY_ROUTE)))throw new SecurityException("Mail route denied");
  guard.check();String raw;synchronized(host.lock()){raw=credential(binding.getString("credentialId"));}JSONObject credential=new JSONObject(raw);if(credential.has("expiresAt")&&credential.getDouble("expiresAt")<=System.currentTimeMillis())throw new SecurityException("Cloud key expired");
  HttpURLConnection connection=connections.open(java.net.URI.create(config.apiBase+path).toURL());
  try{
   connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setRequestMethod("GET");connection.setRequestProperty("Accept","application/json");connection.setRequestProperty("Authorization","Bearer "+credential.getString("token"));
   guard.check();int status=connection.getResponseCode();if(status<200||status>=300)throw new HttpFailure(status);
   ByteArrayOutputStream bytes=new ByteArrayOutputStream();
   try(InputStream in=connection.getInputStream()){byte[] buffer=new byte[8192];for(int n;(n=in.read(buffer))!=-1;){guard.check();if(bytes.size()+n>1100000)throw new IOException("Mail response exceeds bound");bytes.write(buffer,0,n);}}
   guard.check();return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
  }finally{connection.disconnect();}
 }
 private void verify(JSONObject binding,MailHistoryReconciliation.Guard guard)throws Exception{
  JSONObject me=get(binding,USER_ROUTE,guard);if(!me.getBoolean("success"))throw new SecurityException("Cloud identity unavailable");
  JSONObject user=host.verifiedIdentity(me.getJSONObject("data"));
  if(!binding.getString("userId").equals(user.optString("userId",null))||!binding.getString("organizationId").equals(user.optString("organizationId",null)))throw new SecurityException("Cloud owner changed");
  JSONObject response=get(binding,ACCOUNTS_ROUTE,guard);if(!response.getBoolean("success"))throw new SecurityException("Google account unavailable");
  JSONArray accounts=response.getJSONArray("data");if(accounts.length()>128)throw new IOException("Too many Google accounts");boolean found=false;
  for(int i=0;i<accounts.length();i++){JSONObject account=accounts.getJSONObject(i);if(!binding.getString("grantId").equals(account.optString("connectionId"))||!account.optBoolean("connected"))continue;JSONArray caps=account.getJSONArray("grantedCapabilities");for(int j=0;j<caps.length();j++)if(config.readCapability.equals(caps.getString(j)))found=true;}
  guard.check();if(!found)throw new SecurityException("Mail grant unavailable");
 }
 /**
  * One background job for the selection generation the work was scheduled with. Returns true when the job
  * is complete (or must not be retried), false to retry later. Throws SecurityException for a stale job.
  */
 public synchronized boolean sync(String generation,MailHistoryReconciliation.Guard stopped)throws Exception{
  final long epoch=attempts.get();JSONObject binding;
  synchronized(host.lock()){JSONObject s=saved();if(s==null||!s.getJSONObject("binding").getString("generation").equals(generation))throw new SecurityException("Mail job stale");binding=s.getJSONObject("binding");}
  MailHistoryReconciliation.Guard guard=()->{stopped.check();synchronized(host.lock()){if(attempts.get()!=epoch)throw new SecurityException("Mail check superseded");current(binding);}};
  try{
   verify(binding,guard);
   for(int i=0;i<config.pagesPerJob;i++){
    publishNotices(binding,guard);JSONObject query;synchronized(host.lock()){guard.check();query=engine(binding).query();}
    String start=MailHistoryReconciliation.optional(query,"startHistoryId"),token=MailHistoryReconciliation.optional(query,"pageToken");
    String path=HISTORY_ROUTE+URLEncoder.encode(binding.getString("grantId"),"UTF-8")+"&maxResults=50";
    if(start!=null)path+="&startHistoryId="+MailHistoryReconciliation.revision(start);if(token!=null)path+="&pageToken="+URLEncoder.encode(token,"UTF-8");
    JSONObject page=get(binding,path,guard);
    // Recheck the remote grant before a page can cause a durable notice; local epoch fences every write.
    verify(binding,guard);synchronized(host.lock()){guard.check();engine(binding).accept(page,System.currentTimeMillis());}
    publishNotices(binding,guard);
    synchronized(host.lock()){MailHistoryReconciliation engine=engine(binding);if(!"reset-required".equals(page.getString("status"))&&MailHistoryReconciliation.optional(engine.query(),"pageToken")==null)return !engine.hasPending();}
   }
   return false;
  }catch(HttpFailure error){
   synchronized(host.lock()){guard.check();
    if(error.status==401||error.status==403||error.status==409){engine(binding).failure("grant-unavailable");poster.cancelAll();return true;}
    if(error.status==404||error.status==405||error.status==501){engine(binding).failure("unsupported");return true;}
    engine(binding).failure("retrying");}
   return false;
  }catch(SecurityException revoked){
   try{synchronized(host.lock()){guard.check();engine(binding).failure("grant-unavailable");poster.cancelAll();}}catch(Exception stale){/* A stale job leaves the newer selection alone. */}
   throw revoked;
  }catch(Exception failure){synchronized(host.lock()){guard.check();engine(binding).failure(failure instanceof IllegalStateException?"capacity-reached":"retrying");}return false;}
 }
 private void publishNotices(JSONObject binding,MailHistoryReconciliation.Guard guard)throws Exception{for(int i=0;i<25;i++){synchronized(host.lock()){guard.check();MailHistoryReconciliation e=engine(binding);e.publish();if(!e.hasPending())return;}}}
 /** Records a tap on one of this module's notices (open or explicit Ask) for the renderer to claim. */
 public void capture(String key,boolean question)throws Exception{synchronized(host.lock()){JSONObject s=saved();if(s!=null)engine(s.getJSONObject("binding")).capture(key,question);}}
 /** The captured tap, after the owner and grant are verified again; the foreground guard is rechecked after every blocking read. */
 public JSONObject pending(MailHistoryReconciliation.Guard foreground)throws Exception{
  foreground.check();JSONObject binding;
  synchronized(host.lock()){JSONObject s=saved();if(s==null)return new JSONObject();binding=s.getJSONObject("binding");if(!engine(binding).pending().has("token"))return new JSONObject();}
  verify(binding,()->{foreground.check();synchronized(host.lock()){current(binding);}});
  foreground.check();synchronized(host.lock()){foreground.check();return engine(binding).pending();}
 }
 public void releaseQuestion(String token,MailHistoryReconciliation.Guard foreground)throws Exception{foreground.check();synchronized(host.lock()){foreground.check();JSONObject s=saved();if(s==null)throw new SecurityException("Mail selection unavailable");engine(s.getJSONObject("binding")).releaseQuestion(token);}}
 public void consume(String token,MailHistoryReconciliation.Guard foreground)throws Exception{foreground.check();synchronized(host.lock()){foreground.check();JSONObject s=saved();if(s==null)throw new SecurityException("Mail selection unavailable");engine(s.getJSONObject("binding")).consume(token);}}
}

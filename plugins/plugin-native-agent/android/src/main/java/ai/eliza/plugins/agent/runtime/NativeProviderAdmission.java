package ai.eliza.plugins.agent.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Private saved-binding identity and the pure provider admission rules: which hosted provider a
 * launch selects, its environment, the Cloud credential checks and the rollback of a Cloud binding.
 * It grants no reminder permission or authenticated owner role. No Capacitor or Android types, so
 * the native provider admission contract runs it on the host JVM. Inference stays Qwen
 * (qwen-3.8-27b) on Cerebras, directly or through Eliza Cloud.
 */
public class NativeProviderAdmission {
 public static final String CEREBRAS_PROVIDER_MODEL="qwen-3.8-27b";
 public static final String CLOUD_PROVIDER_MODEL="cerebras/qwen-3.8-27b";
 public static final String CLOUD_PROVIDER_BASE="https://api.eliza.app/api/v1";
 public static final String PROVIDER_MODEL_PATTERN="[A-Za-z0-9][A-Za-z0-9._/-]{0,127}";
 /** Safe diagnostics never contain credential values, identities or response bodies. */
 public static final class CloudReadFailure extends SecurityException {
  public final int status;
  public CloudReadFailure(int status){super("Cloud read unavailable");this.status=status>=100&&status<=599?status:0;}
 }
 public static final class CloudBindingFailure extends Exception {
  public final String stage;public final JSONObject diagnostic;
  public CloudBindingFailure(String stage,JSONObject schema,Exception cause)throws Exception{
   super("Cloud admission failed at "+stage,cause);this.stage=stage;
   diagnostic=new JSONObject().put("stage",stage).put("exceptionClass",cause.getClass().getSimpleName()).put("httpStatus",cause instanceof CloudReadFailure?((CloudReadFailure)cause).status:0).put("credentialSchema",schema);
  }
 }
 public static JSONObject cloudCredentialDiagnostics(String saved,String expectedId,long now)throws Exception{
  JSONObject out=new JSONObject().put("present",saved!=null);if(saved==null)return out;
  JSONObject value;try{value=new JSONObject(saved);}catch(Exception malformed){return out.put("schema","invalid-json");}
  Object id=value.opt("credentialId"),token=value.opt("token"),expiry=value.opt("expiresAt");boolean uuid=false;
  try{uuid=id instanceof String&&UUID.fromString((String)id).toString().equalsIgnoreCase((String)id);}catch(Exception malformed){/* Only the boolean leaves storage. */}
  out.put("schema","object").put("credentialIdPresent",id instanceof String).put("credentialIdUuid",uuid).put("providerTokenPresent",token instanceof String).put("providerTokenFormatValid",token instanceof String&&validProviderToken((String)token,16384));
  if(expectedId!=null)out.put("credentialIdMatches",expectedId.equals(id));
  out.put("expiryType",!value.has("expiresAt")?"absent":expiry==JSONObject.NULL?"null":expiry instanceof Number?"number":expiry instanceof String?"string":"other");
  if(expiry instanceof Number)out.put("expiryFinite",Double.isFinite(((Number)expiry).doubleValue())).put("expired",((Number)expiry).doubleValue()<=now);
  return out;
 }
 public static boolean validProviderToken(String token,int maximumLength) {
  if(token==null||token.length()<8||token.length()>maximumLength)return false;
  // HTTP bearer credentials are visible ASCII; reject all whitespace/control characters, including CR/LF runs.
  for(int i=0;i<token.length();i++)if(token.charAt(i)<=0x20||token.charAt(i)>=0x7f)return false;
  return true;
 }
 /** The saved Cloud sign-in token for exactly this credential id, refused when malformed or expired. */
 public static String cloudProviderToken(String saved,String credentialId,long now) throws Exception {
  if(credentialId==null||!UUID.fromString(credentialId).toString().equalsIgnoreCase(credentialId)||saved==null)throw new IllegalArgumentException();
  JSONObject credential=new JSONObject(saved);
  if(!credentialId.equals(credential.opt("credentialId")))throw new IllegalArgumentException();
  Object token=credential.opt("token");
  if(!(token instanceof String)||!validProviderToken((String)token,16384))throw new IllegalArgumentException();
  if(credential.has("expiresAt")){
   Object expiry=credential.opt("expiresAt");
   if(!(expiry instanceof Number)||!Double.isFinite(((Number)expiry).doubleValue())||((Number)expiry).doubleValue()<=now)throw new IllegalArgumentException();
  }
  return (String)token;
 }
 /** Select exactly one billing authority at process launch; never accept UI balance as authorization. */
 public static void applyProviderEnvironment(JSONObject provider,String cloudSaved,java.util.Map<String,String> env,long now) throws Exception {
  String kind=provider.optString("provider","cerebras"),model=provider.getString("model");
  // Retirement context only: reuse protected selection identity, never a credential or renderer value.
  Object selectedRevision=provider.opt("revision");
  String hostRevision;
  if(provider.has("revision")){
   if(!(selectedRevision instanceof String))throw new IllegalArgumentException();
   String revision=UUID.fromString((String)selectedRevision).toString();
   if(!revision.equalsIgnoreCase((String)selectedRevision))throw new IllegalArgumentException();
   hostRevision="provider:"+kind+":"+revision;
  }else{
   // Legacy selections cannot carry an unfinished read across a process restart.
   hostRevision="boot:"+UUID.randomUUID().toString();
  }
  if("elizacloud".equals(kind)){
   if(!CLOUD_PROVIDER_MODEL.equals(model))throw new IllegalArgumentException();
   String token=cloudProviderToken(cloudSaved,provider.getString("credentialId"),now);
   for(String key:new String[]{"CEREBRAS_API_KEY","CEREBRAS_BASE_URL","CEREBRAS_MODEL","CEREBRAS_SMALL_MODEL","CEREBRAS_LARGE_MODEL","OPENAI_API_KEY","OPENAI_BASE_URL","ELIZA_PROVIDER"})env.remove(key);
   env.put("ELIZAOS_CLOUD_API_KEY",token);
   env.put("ELIZAOS_CLOUD_BASE_URL",CLOUD_PROVIDER_BASE);
   env.put("ELIZAOS_CLOUD_USE_INFERENCE","true");
   env.put("ELIZAOS_CLOUD_USE_EMBEDDINGS","true");
   env.put("ELIZAOS_CLOUD_EMBEDDING_MODEL","bge-small-en-v1.5");
   env.put("ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS","384");
   env.put("ELIZA_DISABLE_LOCAL_EMBEDDINGS","true");
   env.put("ELIZA_LOCAL_EMBEDDING_ENABLED","0");
   env.remove("ELIZA_LOCAL_EMBEDDING_MODEL_PATH");env.remove("ELIZA_LOCAL_EMBEDDING_DIMENSIONS");
   env.put("ELIZAOS_CLOUD_SMALL_MODEL",model);
   env.put("ELIZAOS_CLOUD_LARGE_MODEL",model);
  }else if("cerebras".equals(kind)){
   String key=provider.getString("key");
   if(!model.matches(PROVIDER_MODEL_PATTERN)||!validProviderToken(key,1024))throw new IllegalArgumentException();
   // Earlier builds accepted any model name; launch always uses the pinned model.
   model=CEREBRAS_PROVIDER_MODEL;
   for(String name:new String[]{"ELIZAOS_CLOUD_API_KEY","ELIZAOS_CLOUD_BASE_URL","ELIZAOS_CLOUD_SMALL_MODEL","ELIZAOS_CLOUD_LARGE_MODEL","ELIZAOS_CLOUD_USE_EMBEDDINGS","ELIZAOS_CLOUD_EMBEDDING_MODEL","ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS","ELIZA_DISABLE_LOCAL_EMBEDDINGS","ELIZA_LOCAL_EMBEDDING_ENABLED"})env.remove(name);
   env.put("CEREBRAS_API_KEY",key);
   env.put("CEREBRAS_MODEL",model);
   env.put("CEREBRAS_SMALL_MODEL",model);
   env.put("CEREBRAS_LARGE_MODEL",model);
   env.put("ELIZAOS_CLOUD_USE_INFERENCE","false");
  }else throw new IllegalArgumentException();
  env.put("ELIZA_HOST_CONTEXT_REVISION",hostRevision);
 }
 /** Settings may show which hosted provider and model are configured; the key never leaves native storage. */
 public static JSONObject providerIdentity(String saved) {
  JSONObject result=new JSONObject();
  try{
   result.put("provider","cerebras").put("configured",false);
   if(saved==null)return result;
   try{
    JSONObject provider=new JSONObject(saved);
    String model=provider.optString("model",""),kind=provider.optString("provider","cerebras");
    if("elizacloud".equals(kind)){result.put("provider","elizacloud");if(CLOUD_PROVIDER_MODEL.equals(model))result.put("configured",true).put("model",model);}
    else if("cerebras".equals(kind)&&model.matches(PROVIDER_MODEL_PATTERN))result.put("configured",true).put("model",CEREBRAS_PROVIDER_MODEL);
   }catch(org.json.JSONException malformed){/* Report unconfigured, never the stored value. */}
  }catch(org.json.JSONException impossible){throw new IllegalStateException(impossible);}
  return result;
 }
 /** providerIdentity, reported unconfigured when a Cloud selection's credential is missing, expired or another account's. */
 public static JSONObject providerStatus(String saved,String cloudSaved,long now) {
  JSONObject status=providerIdentity(saved);
  if("elizacloud".equals(status.optString("provider"))&&status.optBoolean("configured")){
   try{cloudProviderToken(cloudSaved,new JSONObject(saved).optString("credentialId"),now);}
   catch(Exception unavailable){try{status.put("configured",false);}catch(org.json.JSONException impossible){throw new IllegalStateException(impossible);}}
  }
  return status;
 }
 /** The credential store and identity lookup a Cloud binding needs; AlphaCredentialStore in the app. */
 public interface CloudBindingStore {
  String readProvider()throws Exception;
  String readCloud()throws Exception;
  void assertCurrent()throws Exception;
  /** Verified account identity for the token (GET /api/v1/user); throws when unavailable. */
  JSONObject identity(String token)throws Exception;
  /** Admission compare-exchange; returns the stored binding, or null on conflict. */
  String admit(String previous,String selection,String cloud,JSONObject identity)throws Exception;
  void rollback(String binding,String previous)throws Exception;
 }
 /** Preserve the previous selection when admission loses its account, without replacing a newer selection. */
 public static String bindCloudProvider(CloudBindingStore store,String credentialId,String model,java.util.function.LongSupplier clock) throws Exception {
  String stage="model";JSONObject schema=new JSONObject();
  try{
  if(!CLOUD_PROVIDER_MODEL.equals(model))throw new IllegalArgumentException();
  stage="credential-read";
  String previous=store.readProvider();
  String cloud=store.readCloud();
  store.assertCurrent();
  schema=cloudCredentialDiagnostics(cloud,credentialId,clock.getAsLong());
  stage="credential-validation";String token=cloudProviderToken(cloud,credentialId,clock.getAsLong());
  stage="identity-read";JSONObject identity=store.identity(token);
  store.assertCurrent();
  // A unique revision distinguishes two concurrent admissions for the same account/model.
  String selection=new JSONObject().put("provider","elizacloud").put("credentialId",credentialId).put("model",model)
   .put("revision",UUID.randomUUID().toString()).toString();
  stage="admission-commit";String binding=store.admit(previous,selection,cloud,identity);
  if(binding==null)throw new IllegalStateException();
  stage="confirmation";try{
   cloudProviderToken(store.readCloud(),credentialId,clock.getAsLong());
   if(!binding.equals(store.readProvider()))throw new IllegalStateException();
  }catch(Exception unavailable){
   try{store.rollback(binding,previous);}catch(Exception rollback){stage="rollback";throw rollback;}
   throw unavailable;
  }
  return binding;
  }catch(Exception failure){throw new CloudBindingFailure(stage,schema,failure);}
 }
 private static final String GENERATION="admissionGeneration",FINGERPRINT="admissionFingerprint",CLOUD_IDENTITY="verifiedCloudIdentity";
 /** Public identity of the native-verified Cloud selection; never the bearer. */
 public static JSONObject managedGoogleBinding(String saved,String cloudSaved,long now)throws Exception {
  if(saved==null)throw new SecurityException("Cloud provider admission required");
  JSONObject selected=new JSONObject(saved);
  if(!"elizacloud".equals(selected.optString("provider")))throw new SecurityException("Cloud provider required");
  String credentialId=selected.getString("credentialId");
  cloudProviderToken(cloudSaved,credentialId,now);
  String generation=currentGeneration(saved,cloudSaved);
  if(generation==null)throw new SecurityException("Cloud provider admission changed");
  String reference=cloudAccountRef(selected);JSONArray account=new JSONArray(reference);
  if(account.length()!=4||!"cloud".equals(account.getString(0))||!"production".equals(account.getString(1)))throw new SecurityException("Cloud account admission invalid");
  // A valid Cloud inference account can exist before an organization/Google grant.
  if(account.isNull(3)||account.getString(3).isEmpty())return null;
  JSONObject result=new JSONObject().put("credentialId",credentialId).put("userId",account.getString(2)).put("organizationId",account.getString(3)).put("accountRef",reference).put("sessionGeneration",generation);
  JSONObject credential=new JSONObject(cloudSaved);if(credential.has("expiresAt"))result.put("expiresAt",credential.get("expiresAt"));
  return result;
 }
 private static String uuid(Object value)throws Exception {
  if(!(value instanceof String))throw new IllegalArgumentException();
  String canonical=UUID.fromString((String)value).toString();
  if(!canonical.equals(value))throw new IllegalArgumentException();
  return canonical;
 }
 public static String withoutAdmission(String saved)throws Exception {
  JSONObject provider=new JSONObject(saved);provider.remove(GENERATION);provider.remove(FINGERPRINT);provider.remove(CLOUD_IDENTITY);return provider.toString();
 }
 private static String cloudId(Object value)throws Exception {
  if(!(value instanceof String)||!((String)value).matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))throw new IllegalArgumentException();
  return UUID.fromString((String)value).toString();
 }
 public static JSONObject verifiedCloudIdentity(JSONObject data)throws Exception {
  JSONObject identity=new JSONObject().put("userId",cloudId(data.opt("id")));
  Object organization=data.opt("organization_id");
  if(organization!=null&&organization!=JSONObject.NULL)identity.put("organizationId",cloudId(organization));
  return identity;
 }
 private static JSONObject cloudIdentity(JSONObject selected)throws Exception {
  JSONObject saved=selected.getJSONObject(CLOUD_IDENTITY);
  if(saved.length()<1||saved.length()>2)throw new IllegalArgumentException();
  JSONObject identity=new JSONObject().put("userId",cloudId(saved.opt("userId")));
  if(saved.has("organizationId"))identity.put("organizationId",cloudId(saved.opt("organizationId")));
  if(identity.length()!=saved.length())throw new IllegalArgumentException();
  return identity;
 }
 public static String cloudAccountRef(JSONObject selected)throws Exception {
  JSONObject identity=cloudIdentity(selected);
  return new JSONArray().put("cloud").put("production").put(identity.getString("userId")).put(identity.opt("organizationId")).toString();
 }
 private static JSONArray cloudIdentity(String saved,String expectedId)throws Exception {
  String token=cloudProviderToken(saved,expectedId,System.currentTimeMillis());
  JSONObject credential=new JSONObject(saved);
  return new JSONArray().put("production").put(expectedId).put(credential.opt("userId")).put(credential.opt("organizationId")).put(token);
 }
 /** Metadata/reserialization is not credential replacement; invalid or removed records never match. */
 public static boolean sameCloudCredential(String before,String after){
  try{
   String id=new JSONObject(before).getString("credentialId");
   return cloudIdentity(before,id).toString().equals(cloudIdentity(after,id).toString());
  }catch(Exception unavailable){return false;}
 }
 private static String fingerprint(JSONObject selected,String cloud)throws Exception {
  String kind=selected.optString("provider","cerebras"),model=selected.getString("model");
  JSONArray identity=new JSONArray().put(1).put(kind).put(model);
  if("elizacloud".equals(kind)){
   if(!CLOUD_PROVIDER_MODEL.equals(model)||!"production".equals(selected.optString("environment","production")))throw new IllegalArgumentException();
   String id=selected.getString("credentialId");
   JSONArray credentialIdentity=cloudIdentity(cloud,id);
   // Native sign-in omits optional account metadata; get() rejects those null slots.
   for(int index=0;index<credentialIdentity.length();index++)identity.put(credentialIdentity.opt(index));
   JSONObject verified=cloudIdentity(selected);
   identity.put(verified.getString("userId")).put(verified.opt("organizationId"));
  }else if("cerebras".equals(kind)){
   String key=selected.getString("key");
   if(!model.matches(PROVIDER_MODEL_PATTERN)||!validProviderToken(key,1024))throw new IllegalArgumentException();
   String environment=selected.optString("environment","production");
   if(!"production".equals(environment))throw new IllegalArgumentException();
   identity.put(environment).put(key);
  }else throw new IllegalArgumentException();
  byte[] bytes=identity.toString().getBytes(StandardCharsets.UTF_8);
  try{
   byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder hex=new StringBuilder();
   for(byte value:digest)hex.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
   return hex.toString();
  }finally{java.util.Arrays.fill(bytes,(byte)0);}
 }
 /** Invoked only by explicit native configuration inside the existing credential mutation lock. */
 public static String admit(String previous,String selection,String cloud,JSONObject verifiedIdentity)throws Exception {
  JSONObject selected=new JSONObject(withoutAdmission(selection));
  if("elizacloud".equals(selected.optString("provider"))){
   selected.put(CLOUD_IDENTITY,verifiedIdentity);
   cloudIdentity(selected);
  }else if(verifiedIdentity!=null)throw new IllegalArgumentException();
  String nextFingerprint=fingerprint(selected,cloud),generation=null;
  if(previous!=null){
   try{
    JSONObject old=new JSONObject(previous);
    if(nextFingerprint.equals(old.opt(FINGERPRINT))&&nextFingerprint.equals(fingerprint(old,cloud)))generation=uuid(old.opt(GENERATION));
   }catch(Exception unavailable){/* An old or changed binding receives a fresh identity only on this explicit admission. */}
  }
  selected.put(GENERATION,generation==null?UUID.randomUUID().toString():generation).put(FINGERPRINT,nextFingerprint);
  return selected.toString();
 }
 /** Decision P-43: the resident always starts, also with no provider admitted. A process launched
  * that way carries this generation, distinct from every admitted (UUID) generation, so a later
  * provider binding never attaches to it and takes the ordinary stop, bind, start path. */
 public static final String NO_PROVIDER_GENERATION="no-provider";
 /** The generation a launch records: the stored admission's, or NO_PROVIDER_GENERATION when no
  * provider slot is stored. A stored but invalid admission stays null (never attachable). */
 public static String launchGeneration(String saved,String cloud){
  return saved==null?NO_PROVIDER_GENERATION:currentGeneration(saved,cloud);
 }
 /** Never writes, migrates legacy state, or mints an identity. */
 public static String currentGeneration(String saved,String cloud){
  try{
   JSONObject selected=new JSONObject(saved);
   String generation=uuid(selected.opt(GENERATION));
   return fingerprint(selected,cloud).equals(selected.opt(FINGERPRINT))?generation:null;
  }catch(Exception unavailable){return null;}
 }
}

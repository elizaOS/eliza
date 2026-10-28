package ai.eliza.plugins.agent.runtime;

import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/** Host-JVM contract of the local agent's provider admission. No Android, network or real credential. */
public final class NativeProviderAdmissionTest {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private interface Body{void run()throws Exception;}
 private static void refused(Body body,String message){
  try{body.run();}catch(Exception expected){return;}
  throw new AssertionError(message);
 }
 static final String ID="0f8fad5b-d9cb-469f-a165-70867728950e",OTHER="7c9e6679-7425-40de-944b-e07fc1f90ae7";
 static final String TOKEN="eliza_test_token_not_a_secret_0123456789",KEY="csk-test-key-not-a-secret-0123";
 static final long NOW=1_800_000_000_000L;
 static String cloud(String id,Object expiresAt)throws Exception{
  JSONObject value=new JSONObject().put("credentialId",id).put("token",TOKEN).put("userId","3b241101-e2bb-4255-8caf-4136c566a962").put("organizationId","6ba7b810-9dad-41d1-80b4-00c04fd430c8");
  if(expiresAt!=null)value.put("expiresAt",expiresAt);
  return value.toString();
 }
 static Map<String,String> inherited(){
  Map<String,String> env=new HashMap<>();
  for(String key:new String[]{"CEREBRAS_API_KEY","CEREBRAS_BASE_URL","CEREBRAS_MODEL","CEREBRAS_SMALL_MODEL","CEREBRAS_LARGE_MODEL","OPENAI_API_KEY","OPENAI_BASE_URL","ELIZA_PROVIDER","ELIZAOS_CLOUD_API_KEY","ELIZAOS_CLOUD_SMALL_MODEL"})env.put(key,"stale");
  return env;
 }
 /** In-memory store whose admit is the real admission compare-exchange. */
 static final class Store implements NativeProviderAdmission.CloudBindingStore {
  String provider,cloud,cloudAfterAdmit;boolean identityFails,conflict,readFails,rollbackFails;int rollbacks,identityHttpStatus;
  public String readProvider(){if(readFails)throw new SecurityException(TOKEN+KEY);return provider;}
  public String readCloud(){return cloud;}
  public void assertCurrent(){}
  public JSONObject identity(String token)throws Exception{
   if(identityHttpStatus>0)throw new NativeProviderAdmission.CloudReadFailure(identityHttpStatus);
   if(identityFails)throw new SecurityException("Cloud identity unavailable");
   check(TOKEN.equals(token),"the identity lookup receives the saved token");
   return new JSONObject().put("userId","3b241101-e2bb-4255-8caf-4136c566a962");
  }
  public String admit(String previous,String selection,String cloudValue,JSONObject identity)throws Exception{
   if(conflict||!java.util.Objects.equals(previous,provider))return null;
   provider=NativeProviderAdmission.admit(previous,selection,cloudValue,identity);
   if(cloudAfterAdmit!=null)cloud=cloudAfterAdmit;
   return provider;
  }
  public void rollback(String binding,String previous)throws Exception{
   rollbacks++;if(rollbackFails)throw new SecurityException(TOKEN+KEY);
   if(binding.equals(provider))provider=previous==null?null:NativeProviderAdmission.withoutAdmission(previous);
  }
 }
 public static void main(String[] args)throws Exception {
  // Eliza Cloud: one billing authority, the pinned Qwen model, no direct Cerebras or OpenAI variables.
  JSONObject selected=new JSONObject().put("provider","elizacloud").put("credentialId",ID).put("model","cerebras/qwen-3.8-27b").put("revision","9b2d6c34-6f0a-4d0e-9f63-2b8e1f0c7a11");
  Map<String,String> env=inherited();
  NativeProviderAdmission.applyProviderEnvironment(selected,cloud(ID,NOW+1),env,NOW);
  check(TOKEN.equals(env.get("ELIZAOS_CLOUD_API_KEY")),"Cloud token is the inference key");
  check("https://api.eliza.app/api/v1".equals(env.get("ELIZAOS_CLOUD_BASE_URL")),"production Cloud API");
  check("true".equals(env.get("ELIZAOS_CLOUD_USE_INFERENCE")),"Cloud inference on");
  check("cerebras/qwen-3.8-27b".equals(env.get("ELIZAOS_CLOUD_SMALL_MODEL"))&&"cerebras/qwen-3.8-27b".equals(env.get("ELIZAOS_CLOUD_LARGE_MODEL")),"Cloud models are the pinned Qwen");
  for(String key:env.keySet())check(!key.startsWith("CEREBRAS_")&&!key.startsWith("OPENAI_")&&!"ELIZA_PROVIDER".equals(key),"elizacloud removes "+key);
  check("provider:elizacloud:9b2d6c34-6f0a-4d0e-9f63-2b8e1f0c7a11".equals(env.get("ELIZA_HOST_CONTEXT_REVISION")),"host revision comes from the selection");
  // Only cerebras/qwen-3.8-27b; expired, malformed or another credential's token is refused.
  for(String model:new String[]{"qwen-3.8-27b","cerebras/llama-4","openai/gpt-5","cerebras/qwen-3.8-27b ",""}){
   JSONObject other=new JSONObject(selected.toString()).put("model",model);
   refused(()->NativeProviderAdmission.applyProviderEnvironment(other,cloud(ID,null),inherited(),NOW),"Cloud refuses model "+model);
  }
  refused(()->NativeProviderAdmission.applyProviderEnvironment(selected,cloud(ID,NOW),inherited(),NOW),"expiry at now is expired");
  refused(()->NativeProviderAdmission.applyProviderEnvironment(selected,cloud(ID,NOW-1),inherited(),NOW),"expired credential");
  check(TOKEN.equals(NativeProviderAdmission.cloudProviderToken(cloud(ID,NOW+1),ID,NOW)),"one millisecond before expiry is valid");
  check(TOKEN.equals(NativeProviderAdmission.cloudProviderToken(cloud(ID,null),ID,NOW)),"no expiry recorded is valid");
  refused(()->NativeProviderAdmission.applyProviderEnvironment(selected,cloud(OTHER,null),inherited(),NOW),"mismatched credentialId");
  refused(()->NativeProviderAdmission.applyProviderEnvironment(selected,null,inherited(),NOW),"missing Cloud credential");
  for(String malformed:new String[]{"not json","{}","{\"credentialId\":\""+ID+"\"}","{\"credentialId\":\""+ID+"\",\"token\":\"short\"}","{\"credentialId\":\""+ID+"\",\"token\":\"has space in the token\"}",
   "{\"credentialId\":\""+ID+"\",\"token\":\""+TOKEN+"\",\"expiresAt\":\"tomorrow\"}","{\"credentialId\":\""+ID+"\",\"token\":12345678901}"})
   refused(()->NativeProviderAdmission.cloudProviderToken(malformed,ID,NOW),"malformed credential "+malformed);
  for(String id:new String[]{"not-a-uuid",ID.toUpperCase(java.util.Locale.ROOT)+"x","",null})refused(()->NativeProviderAdmission.cloudProviderToken(cloud(ID,null),id,NOW),"malformed credentialId "+id);
  // Direct Cerebras: launch always uses qwen-3.8-27b and clears every Cloud variable.
  JSONObject direct=new JSONObject().put("provider","cerebras").put("key",KEY).put("model","llama-legacy");
  Map<String,String> directEnv=inherited();
  NativeProviderAdmission.applyProviderEnvironment(direct,null,directEnv,NOW);
  for(String key:new String[]{"CEREBRAS_MODEL","CEREBRAS_SMALL_MODEL","CEREBRAS_LARGE_MODEL"})check("qwen-3.8-27b".equals(directEnv.get(key)),"Cerebras forces qwen-3.8-27b for "+key);
  check(KEY.equals(directEnv.get("CEREBRAS_API_KEY"))&&"false".equals(directEnv.get("ELIZAOS_CLOUD_USE_INFERENCE")),"direct key, Cloud inference off");
  check(!directEnv.containsKey("ELIZAOS_CLOUD_API_KEY")&&!directEnv.containsKey("ELIZAOS_CLOUD_SMALL_MODEL"),"Cloud key and models removed");
  check(directEnv.get("ELIZA_HOST_CONTEXT_REVISION").startsWith("boot:"),"a legacy selection gets a boot revision");
  refused(()->NativeProviderAdmission.applyProviderEnvironment(new JSONObject().put("provider","cerebras").put("key","bad key!").put("model","qwen-3.8-27b"),null,inherited(),NOW),"invalid direct key");
  refused(()->NativeProviderAdmission.applyProviderEnvironment(new JSONObject().put("provider","openai").put("model","gpt"),null,inherited(),NOW),"unknown provider");
  // Identity and status never carry a credential; an expired or another account's Cloud token is unconfigured.
  String cloudSelection=selected.toString(),directSelection=new JSONObject().put("provider","cerebras").put("key",KEY).put("model","qwen-3.8-27b").toString();
  JSONObject identity=NativeProviderAdmission.providerIdentity(cloudSelection);
  check("elizacloud".equals(identity.getString("provider"))&&identity.getBoolean("configured")&&"cerebras/qwen-3.8-27b".equals(identity.getString("model")),"Cloud identity");
  check(NativeProviderAdmission.providerStatus(cloudSelection,cloud(ID,NOW+1),NOW).getBoolean("configured"),"valid Cloud credential is configured");
  check(!NativeProviderAdmission.providerStatus(cloudSelection,cloud(ID,NOW),NOW).getBoolean("configured"),"expired Cloud credential reports configured:false");
  check(!NativeProviderAdmission.providerStatus(cloudSelection,cloud(OTHER,null),NOW).getBoolean("configured"),"another credential reports configured:false");
  check(!NativeProviderAdmission.providerStatus(cloudSelection,null,NOW).getBoolean("configured"),"signed out reports configured:false");
  check(!NativeProviderAdmission.providerIdentity(new JSONObject(cloudSelection).put("model","cerebras/llama").toString()).getBoolean("configured"),"unsupported Cloud model is unconfigured");
  JSONObject directIdentity=NativeProviderAdmission.providerIdentity(new JSONObject(directSelection).put("model","llama-legacy").toString());
  check(directIdentity.getBoolean("configured")&&"qwen-3.8-27b".equals(directIdentity.getString("model")),"a legacy direct selection reports the pinned model");
  check(!NativeProviderAdmission.providerIdentity("{broken").getBoolean("configured")&&!NativeProviderAdmission.providerIdentity(null).getBoolean("configured"),"malformed or absent is unconfigured");
  for(String output:new String[]{identity.toString(),directIdentity.toString(),NativeProviderAdmission.providerStatus(cloudSelection,cloud(ID,null),NOW).toString(),NativeProviderAdmission.providerStatus(directSelection,null,NOW).toString()})
   check(!output.contains(TOKEN)&&!output.contains(KEY)&&!output.contains("token")&&!output.contains("key"),"no credential in "+output);
  // Binding: success stores the admission; a failure after admission rolls back to the previous selection.
  Store store=new Store();store.provider=directSelection;store.cloud=cloud(ID,NOW+60_000);
  String bound=NativeProviderAdmission.bindCloudProvider(store,ID,"cerebras/qwen-3.8-27b",()->NOW);
  check(bound.equals(store.provider)&&"elizacloud".equals(new JSONObject(bound).getString("provider"))&&store.rollbacks==0,"Cloud binding admitted");
  check(!bound.contains(TOKEN),"the stored binding carries no Cloud token");
  check(NativeProviderAdmission.currentGeneration(bound,store.cloud)!=null,"the binding has an admission generation");
  // P-43: a resident launched with no provider slot records its own generation, never an admitted one.
  check(NativeProviderAdmission.NO_PROVIDER_GENERATION.equals(NativeProviderAdmission.launchGeneration(null,null)),"no provider slot launches with the no-provider generation");
  check(NativeProviderAdmission.launchGeneration(bound,store.cloud).equals(NativeProviderAdmission.currentGeneration(bound,store.cloud)),"an admitted slot launches with its admission generation");
  check(!NativeProviderAdmission.NO_PROVIDER_GENERATION.equals(NativeProviderAdmission.currentGeneration(bound,store.cloud)),"an admitted generation is never the no-provider generation");
  check(NativeProviderAdmission.launchGeneration("{}",null)==null,"an invalid stored admission is never attachable");
  Store expiring=new Store();expiring.provider=directSelection;expiring.cloud=cloud(ID,NOW+60_000);expiring.cloudAfterAdmit=cloud(ID,NOW-1);
  refused(()->NativeProviderAdmission.bindCloudProvider(expiring,ID,"cerebras/qwen-3.8-27b",()->NOW),"credential expired during admission");
  check(expiring.rollbacks==1&&directSelection.equals(expiring.provider),"rollback keeps the previous selection");
  Store switched=new Store();switched.provider=directSelection;switched.cloud=cloud(ID,null);switched.cloudAfterAdmit=cloud(OTHER,null);
  refused(()->NativeProviderAdmission.bindCloudProvider(switched,ID,"cerebras/qwen-3.8-27b",()->NOW),"another account signed in during admission");
  check(switched.rollbacks==1&&directSelection.equals(switched.provider),"rollback after an account switch");
  Store first=new Store();first.cloud=cloud(ID,NOW-1);
  refused(()->NativeProviderAdmission.bindCloudProvider(first,ID,"cerebras/qwen-3.8-27b",()->NOW),"an expired credential is never admitted");
  check(first.provider==null&&first.rollbacks==0,"nothing was written");
  Store noIdentity=new Store();noIdentity.provider=directSelection;noIdentity.cloud=cloud(ID,null);noIdentity.identityFails=true;
  refused(()->NativeProviderAdmission.bindCloudProvider(noIdentity,ID,"cerebras/qwen-3.8-27b",()->NOW),"unverified account");
  check(directSelection.equals(noIdentity.provider)&&noIdentity.rollbacks==0,"an unverified account leaves the selection alone");
  Store conflict=new Store();conflict.provider=directSelection;conflict.cloud=cloud(ID,null);conflict.conflict=true;
  refused(()->NativeProviderAdmission.bindCloudProvider(conflict,ID,"cerebras/qwen-3.8-27b",()->NOW),"a concurrent selection wins");
  check(directSelection.equals(conflict.provider),"a newer selection is never replaced");
  refused(()->NativeProviderAdmission.bindCloudProvider(new Store(),ID,"cerebras/llama",()->NOW),"Cloud binding refuses other models");
  refused(()->NativeProviderAdmission.bindCloudProvider(store,OTHER,"cerebras/qwen-3.8-27b",()->NOW),"Cloud binding refuses another credential id");
  check(NativeProviderAdmission.managedGoogleBinding(bound,store.cloud,NOW)==null,"Cloud without an organization keeps inference but does not enable Google tools");
  String googleCloud=cloud(ID,NOW+60_000);
  // Native App Auth stores token identity without optional renderer account metadata.
  Store minimalCredential=new Store();
  minimalCredential.cloud=new JSONObject().put("credentialId",ID).put("token",TOKEN).put("expiresAt",NOW+60_000).toString();
  String minimalBinding=NativeProviderAdmission.bindCloudProvider(minimalCredential,ID,NativeProviderAdmission.CLOUD_PROVIDER_MODEL,()->NOW);
  check(NativeProviderAdmission.currentGeneration(minimalBinding,minimalCredential.cloud)!=null,"native sign-in credentials admit without optional account metadata");
  check(NativeProviderAdmission.managedGoogleBinding(minimalBinding,minimalCredential.cloud,NOW)==null,"missing verified organization still grants no Google tools");
  JSONObject googleIdentity=new JSONObject().put("userId","3b241101-e2bb-4255-8caf-4136c566a962").put("organizationId","6ba7b810-9dad-41d1-80b4-00c04fd430c8");
  String minimalGoogle=NativeProviderAdmission.admit(null,selected.toString(),minimalCredential.cloud,googleIdentity);
  check(NativeProviderAdmission.managedGoogleBinding(minimalGoogle,minimalCredential.cloud,NOW).getString("organizationId").equals(googleIdentity.getString("organizationId")),"native sign-in Google binding uses only the verified server organization");
  String googleSelected=NativeProviderAdmission.admit(null,selected.toString(),googleCloud,googleIdentity);
  JSONObject google=NativeProviderAdmission.managedGoogleBinding(googleSelected,googleCloud,NOW);
  check(google.getString("accountRef").equals(NativeProviderAdmission.cloudAccountRef(new JSONObject(googleSelected))),"Google account is native-admitted");
  check(google.getString("sessionGeneration").equals(NativeProviderAdmission.currentGeneration(googleSelected,googleCloud)),"Google launch uses exact admission generation");
  check(!google.toString().contains(TOKEN)&&!google.has("token"),"Google binding contains no bearer");
  refused(()->NativeProviderAdmission.managedGoogleBinding(googleSelected,cloud(OTHER,NOW+60_000),NOW),"Google refuses credential switch");
  refused(()->NativeProviderAdmission.managedGoogleBinding(googleSelected,googleCloud,NOW+60_001),"Google refuses expired credential");
  refused(()->NativeProviderAdmission.managedGoogleBinding(directSelection,null,NOW),"Google refuses direct-provider selection");
  // Diagnostics preserve all admission/refusal/rollback behavior and expose no values.
  for(String value:new String[]{null,"{broken",cloud(ID,NOW+1000),cloud(ID,"private-expiry-marker"),new JSONObject().put("token",TOKEN).put("credentialId",ID).put("privateExtra",KEY).toString()}){
   String diagnostic=NativeProviderAdmission.cloudCredentialDiagnostics(value,ID,NOW).toString();
   for(String secret:new String[]{TOKEN,KEY,ID,"3b241101-e2bb-4255-8caf-4136c566a962","6ba7b810-9dad-41d1-80b4-00c04fd430c8","private-expiry-marker","privateExtra"})check(!diagnostic.contains(secret),"diagnostics never expose "+secret);
  }
  JSONObject schema=NativeProviderAdmission.cloudCredentialDiagnostics(cloud(ID,NOW-1),OTHER,NOW);
  check(!schema.getBoolean("credentialIdMatches")&&schema.getBoolean("expired")&&"number".equals(schema.getString("expiryType")),"public credential schema is accurate");
  for(String expectedStage:new String[]{"model","credential-read","credential-validation","identity-read","admission-commit","confirmation","rollback"}){
   Store diagnosticStore=new Store();diagnosticStore.cloud=cloud(ID,NOW+1000);diagnosticStore.provider=directSelection;
   if(expectedStage.equals("credential-read"))diagnosticStore.readFails=true;
   if(expectedStage.equals("credential-validation"))diagnosticStore.cloud=null;
   if(expectedStage.equals("identity-read"))diagnosticStore.identityHttpStatus=403;
   if(expectedStage.equals("admission-commit"))diagnosticStore.conflict=true;
   if(expectedStage.equals("confirmation")||expectedStage.equals("rollback"))diagnosticStore.cloudAfterAdmit=cloud(OTHER,NOW+1000);
   if(expectedStage.equals("rollback"))diagnosticStore.rollbackFails=true;
   try{NativeProviderAdmission.bindCloudProvider(diagnosticStore,ID,expectedStage.equals("model")?"unsupported-model":"cerebras/qwen-3.8-27b",()->NOW);throw new AssertionError("Expected diagnostic refusal");}
   catch(NativeProviderAdmission.CloudBindingFailure failure){
    check(expectedStage.equals(failure.stage),"exact failed stage");String diagnostic=failure.diagnostic.toString();
    for(String secret:new String[]{TOKEN,KEY,ID,OTHER,"3b241101-e2bb-4255-8caf-4136c566a962","6ba7b810-9dad-41d1-80b4-00c04fd430c8"})check(!diagnostic.contains(secret),"failure diagnostics contain no credential or identity values");
    check(failure.diagnostic.getInt("httpStatus")== (expectedStage.equals("identity-read")?403:0),"safe HTTP status retained");
   }
   if(expectedStage.equals("rollback"))check(diagnosticStore.rollbacks==1&&!NativeProviderAdmission.providerStatus(diagnosticStore.provider,diagnosticStore.cloud,NOW).getBoolean("configured"),"failed rollback remains unconfirmed and unusable, never falsely restored");
   else check(diagnosticStore.provider.equals(directSelection),"diagnostics never weaken refusal or rollback");
  }
  for(int status:new int[]{401,403,404,429,500,503})check(new NativeProviderAdmission.CloudReadFailure(status) instanceof SecurityException,"all HTTP failures preserve the existing Calendar SecurityException classification");
  System.out.println("PASS local agent provider admission");
 }
}

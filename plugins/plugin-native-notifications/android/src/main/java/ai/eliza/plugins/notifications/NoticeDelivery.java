package ai.eliza.plugins.notifications;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** At-most-once OS dispatch. An uncertain or dismissed notice is never reposted. */
public final class NoticeDelivery {
 public interface Storage {String read(String slot)throws Exception;void write(String slot,String value)throws Exception;}
 public interface Poster {
  boolean allowed();void post(String id,String title,String body)throws Exception;boolean matches(String id,String title,String body)throws Exception;
  /** Approval notices use their own high-importance channel, which the owner can mute separately. */
  default boolean approvalsAllowed(){return allowed();}
  default void postApproval(String id,String title,String body,long timeoutMs)throws Exception{throw new UnsupportedOperationException("Approval notices unavailable");}
  default void cancel(String id){}
 }
 /** Immutable host inputs. Keep deployed slot names when adopting the shared ledger. */
 public static final class Config {
  final String noticeSlot,approvalSlot,approvalTitle,approvalBody;
  final long maximumApprovalMs;
  public Config(String noticeSlot,String approvalSlot,String approvalTitle,String approvalBody,long maximumApprovalMs){
   if(noticeSlot==null||noticeSlot.isBlank()||approvalSlot==null||approvalSlot.isBlank()||noticeSlot.equals(approvalSlot)||maximumApprovalMs<=0)throw new IllegalArgumentException("Invalid notice configuration");
   this.noticeSlot=noticeSlot;this.approvalSlot=approvalSlot;
   this.approvalTitle=text(approvalTitle,200);this.approvalBody=text(approvalBody,2000);this.maximumApprovalMs=maximumApprovalMs;
  }
 }
 public static boolean approvalId(String id){return id!=null&&id.matches("approval-[a-f0-9]{64}");}
 /** Time until the approval expires, or -1 when it already expired. */
 public long approvalTimeout(long expiresAt,long now){if(expiresAt-now>config.maximumApprovalMs)throw new IllegalArgumentException("Approval expiry exceeds the reviewed bound");return expiresAt<=now?-1:expiresAt-now;}
 private static final Object LOCK=new Object();
 private final Config config;
 private final Storage storage;private final Poster poster;
 public NoticeDelivery(Config config,Storage storage,Poster poster){this.config=java.util.Objects.requireNonNull(config);this.storage=java.util.Objects.requireNonNull(storage);this.poster=java.util.Objects.requireNonNull(poster);}
 private static String text(String value,int maximum){if(value==null||value.isBlank()||value.length()>maximum||value.indexOf('\0')>=0)throw new IllegalArgumentException("Invalid notification text");return value;}
 private static String hash(String value)throws Exception{byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
 private static String identity(String id,String binding,String title,String body)throws Exception{
  if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}")||binding==null||!binding.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid notification binding");
  return hash(new JSONArray().put(text(title,200)).put(text(body,2000)).toString());
 }
 private JSONObject ledger()throws Exception{String raw=storage.read(config.noticeSlot);JSONObject ledger=raw==null?new JSONObject():new JSONObject(raw);if(ledger.length()>512)throw new IllegalStateException("Notification receipt capacity exceeded");return ledger;}
 private String retained(JSONObject ledger,JSONObject record,String id,String binding,String digest,String title,String body)throws Exception{
  if(record.length()!=3||!binding.equals(record.getString("binding"))||!digest.equals(record.getString("digest"))||!Set.of("applying","succeeded","failed","unknown").contains(record.getString("status")))throw new IllegalStateException("Notification receipt mismatch");
  if(Set.of("applying","unknown").contains(record.getString("status"))){String status=poster.matches(id,title,body)?"succeeded":"unknown";if(!status.equals(record.getString("status"))){record.put("status",status);storage.write(config.noticeSlot,ledger.toString());}}
  return record.getString("status");
 }
 public String receipt(String id,String binding,String title,String body)throws Exception{synchronized(LOCK){String digest=identity(id,binding,title,body);JSONObject ledger=ledger(),record=ledger.optJSONObject(id);if(record==null){if(ledger.has(id))throw new IllegalStateException("Invalid notification receipt");return "unknown";}return retained(ledger,record,id,binding,digest,title,body);}}
 public String publish(String id,String binding,String title,String body)throws Exception{synchronized(LOCK){
  String digest=identity(id,binding,title,body);JSONObject ledger=ledger(),record=ledger.optJSONObject(id);
  if(record!=null)return retained(ledger,record,id,binding,digest,title,body);
  if(ledger.has(id)||ledger.length()>=512)throw new IllegalStateException("Notification receipt history is full or unavailable");
  record=new JSONObject().put("binding",binding).put("digest",digest).put("status",poster.allowed()?"applying":"failed");ledger.put(id,record);
  storage.write(config.noticeSlot,ledger.toString()); // A committed intent precedes every OS effect.
  if(record.getString("status").equals("failed"))return "failed";
  try{poster.post(id,title,body);record.put("status",poster.matches(id,title,body)?"succeeded":"unknown");}
  catch(Exception failure){record.put("status","unknown");}
  storage.write(config.noticeSlot,ledger.toString());return record.getString("status");
 }}
 private JSONObject approvals()throws Exception{String raw=storage.read(config.approvalSlot);JSONObject ledger=raw==null?new JSONObject():new JSONObject(raw);if(ledger.length()>256)throw new IllegalStateException("Approval notice capacity exceeded");return ledger;}
 private static void approvalRecord(JSONObject record,String binding,String digest)throws Exception{
  if(record.length()!=4||!binding.equals(record.getString("binding"))||!digest.equals(record.getString("digest"))||!Set.of("applying","succeeded","failed","unknown","withdrawn").contains(record.getString("status")))throw new IllegalStateException("Approval notice receipt mismatch");
  Object at=record.get("expiresAt");if(!(at instanceof Integer||at instanceof Long))throw new IllegalStateException("Approval notice receipt mismatch");
 }
 /** One redacted notice per pending phone-step approval ID, posted at most once and never after a decision withdrew it. */
 public String publishApproval(String id,String binding,long expiresAt,long now)throws Exception{synchronized(LOCK){
  if(!approvalId(id))throw new IllegalArgumentException("Invalid approval notice identity");
  String digest=identity(id,binding,config.approvalTitle,config.approvalBody);long timeout=approvalTimeout(expiresAt,now);
  JSONObject ledger=approvals(),record=ledger.optJSONObject(id);
  if(record!=null&&record.length()==2&&"withdrawn".equals(record.optString("status"))){
   Object until=record.get("expiresAt");if(!(until instanceof Integer||until instanceof Long))throw new IllegalStateException("Invalid withdrawal receipt");
   return "withdrawn";
  }
  if(record!=null){approvalRecord(record,binding,digest);if(expiresAt!=record.getLong("expiresAt"))throw new IllegalStateException("Approval notice expiry changed");
   if(Set.of("applying","unknown").contains(record.getString("status"))){String status=poster.matches(id,config.approvalTitle,config.approvalBody)?"succeeded":"unknown";if(!status.equals(record.getString("status"))){record.put("status",status);storage.write(config.approvalSlot,ledger.toString());}}
   return record.getString("status");}
  if(ledger.has(id))throw new IllegalStateException("Invalid approval notice receipt");
  if(timeout<0)return "expired";
  if(ledger.length()>=256)throw new IllegalStateException("Approval notice history is full");
  record=new JSONObject().put("binding",binding).put("digest",digest).put("status",poster.approvalsAllowed()?"applying":"failed").put("expiresAt",expiresAt);ledger.put(id,record);
  storage.write(config.approvalSlot,ledger.toString()); // A committed intent precedes every OS effect.
  if(record.getString("status").equals("failed"))return "failed";
  try{poster.postApproval(id,config.approvalTitle,config.approvalBody,timeout);record.put("status",poster.matches(id,config.approvalTitle,config.approvalBody)?"succeeded":"unknown");}
  catch(Exception failure){record.put("status","unknown");}
  storage.write(config.approvalSlot,ledger.toString());return record.getString("status");
 }}
 /** A decision withdraws the notice. The receipt stays (as withdrawn) until expiry, so the notice is never reposted. */
 public void withdrawApproval(String id,long now)throws Exception{synchronized(LOCK){
  if(!approvalId(id))throw new IllegalArgumentException("Invalid approval notice identity");
  JSONObject ledger=approvals(),record=ledger.optJSONObject(id);
  if(record==null){
   if(ledger.has(id)||ledger.length()>=256)throw new IllegalStateException("Approval notice history is full or unavailable");
   // The host can receive a decision before it has seen the pending approval's binding/expiry.
   // Retain the opaque ID for the maximum lifetime of any approval already issued at withdrawal.
   record=new JSONObject().put("status","withdrawn").put("expiresAt",Math.addExact(now,config.maximumApprovalMs));
   ledger.put(id,record);storage.write(config.approvalSlot,ledger.toString());
  }else if(!"withdrawn".equals(record.getString("status"))){record.put("status","withdrawn");storage.write(config.approvalSlot,ledger.toString());}
  poster.cancel(id);
 }}
 /** Removes receipts whose approval expired (the OS already timed the notice out) and returns their IDs. */
 public java.util.List<String> expireApprovals(long now)throws Exception{synchronized(LOCK){
  JSONObject ledger=approvals();java.util.List<String> expired=new java.util.ArrayList<>();
  for(java.util.Iterator<String> keys=ledger.keys();keys.hasNext();){String id=keys.next();if(ledger.getJSONObject(id).getLong("expiresAt")<=now)expired.add(id);}
  for(String id:expired){ledger.remove(id);poster.cancel(id);}
  if(!expired.isEmpty())storage.write(config.approvalSlot,ledger.toString());return expired;
 }}
}

package ai.eliza.plugins.notifications;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Encrypted, bounded, owner-fenced routes for the host's own notices. A tap is a read request for its
 * exact route, never a decision: it opens only while the notice's delivery receipt is posted and its
 * owner is current. Routes live in host storage (commit before return); all callers share one lock. */
public class NoticeRoutes {
 public static final class UnknownTap extends Exception {}
 /** Immutable host inputs. Keep deployed slot names and route fields when adopting the shared ledger. */
 public static final class Config {
  final String routeSlot,ownerSlot;final NoticeDelivery.Config delivery;final Set<String> fields,identifiers;
  /** `identifiers` name the host's opaque route identities (for example workflowId, runId, versionId). */
  public Config(String routeSlot,String ownerSlot,NoticeDelivery.Config delivery,String... identifiers){
   if(routeSlot==null||routeSlot.isBlank()||ownerSlot==null||ownerSlot.isBlank()||routeSlot.equals(ownerSlot)||delivery==null||Set.of(delivery.noticeSlot,delivery.approvalSlot).contains(routeSlot)||Set.of(delivery.noticeSlot,delivery.approvalSlot).contains(ownerSlot))throw new IllegalArgumentException("Invalid notice route configuration");
   Set<String> ids=new LinkedHashSet<>();for(String id:identifiers){if(id==null||!id.matches("[A-Za-z][A-Za-z0-9]{0,63}")||Set.of("scope","origin","ownerId","agentId").contains(id)||!ids.add(id))throw new IllegalArgumentException("Invalid notice route identifier");}
   Set<String> all=new LinkedHashSet<>(List.of("scope","origin","ownerId","agentId"));all.addAll(ids);
   this.routeSlot=routeSlot;this.ownerSlot=ownerSlot;this.delivery=delivery;this.identifiers=Collections.unmodifiableSet(ids);this.fields=Collections.unmodifiableSet(all);
  }
 }
 private static final Object LOCK=new Object();
 private final NoticeDelivery.Storage storage;private final Config config;
 public NoticeRoutes(NoticeDelivery.Storage storage,Config config){this.storage=Objects.requireNonNull(storage);this.config=Objects.requireNonNull(config);}
 private JSONObject ledger()throws Exception{
  String raw=storage.read(config.routeSlot);JSONObject rows=raw==null?new JSONObject():new JSONObject(raw);
  if(rows.length()>512)throw new IllegalStateException("Notification route capacity exceeded");
  Set<String> tokens=new HashSet<>();Set<Long> orders=new HashSet<>();
  for(String id:keys(rows)){
   JSONObject row=rows.getJSONObject(id);
   if(!id.matches("[A-Za-z0-9_-]{1,128}")||!(keys(row).equals(Set.of("binding","route","token","state","order"))||keys(row).equals(Set.of("binding","route","token","state","order","question"))&&Boolean.TRUE.equals(row.opt("question")))||!row.getString("binding").matches("[a-f0-9]{64}")||!row.getString("token").matches("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")||!tokens.add(row.getString("token"))||!Set.of("new","pending","consumed").contains(row.getString("state")))throw new IllegalStateException("Invalid notification route ledger");
   route(row.getJSONObject("route"));Object rawOrder=row.get("order");long order=row.getLong("order");
   if(!(rawOrder instanceof Integer||rawOrder instanceof Long)||order<0||order==0&&!row.getString("state").equals("new")||order>0&&!orders.add(order))throw new IllegalStateException("Invalid notification tap order");
  }
  return rows;
 }
 private static Set<String> keys(JSONObject value){Set<String> result=new HashSet<>();Iterator<String> iterator=value.keys();while(iterator.hasNext())result.add(iterator.next());return result;}
 /** The exact route shape: owner identity, a 64-hex scope and the configured identifiers. */
 public JSONObject route(JSONObject input)throws Exception{
  if(input==null||!keys(input).equals(config.fields))throw new IllegalArgumentException("Invalid notice route");
  JSONObject result=new JSONObject();
  for(String key:config.fields){Object raw=input.get(key);if(!(raw instanceof String))throw new IllegalArgumentException("Invalid notice route");String value=(String)raw;
   if(value.isBlank()||value.length()>(key.equals("origin")?2048:128)||value.indexOf('\0')>=0)throw new IllegalArgumentException("Invalid notice route");
   if(key.equals("scope")&&!value.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid notice route");
   if(config.identifiers.contains(key)&&!value.matches("[A-Za-z0-9][A-Za-z0-9_-]*"))throw new IllegalArgumentException("Invalid notice route");
   result.put(key,value);
  }return result;
 }
 private boolean same(JSONObject a,JSONObject b)throws Exception{if(!keys(a).equals(keys(b)))return false;for(String k:keys(a))if(!a.get(k).equals(b.get(k)))return false;return true;}
 /** Reserves (or returns) the route token for one notice before it is posted. */
 public String prepare(String id,String binding,JSONObject input)throws Exception{synchronized(LOCK){
  if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}")||binding==null||!binding.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid notice route identity");
  JSONObject exact=route(input);if(!ownerMatches(exact))throw new IllegalStateException("Notification owner changed");JSONObject rows=ledger(),row=rows.optJSONObject(id);
  if(row!=null){if(!binding.equals(row.getString("binding"))||!same(exact,route(row.getJSONObject("route"))))throw new IllegalStateException("Notification route changed");return row.getString("token");}
  if(rows.has(id)||rows.length()>=512)throw new IllegalStateException("Notification routes full");
  String token=UUID.randomUUID().toString();rows.put(id,new JSONObject().put("binding",binding).put("route",exact).put("token",token).put("state","new").put("order",0));storage.write(config.routeSlot,rows.toString());return token;
 }}
 public String token(String id)throws Exception{synchronized(LOCK){JSONObject row=ledger().optJSONObject(id);return row==null?null:row.getString("token");}}
 /** Persists the current owner (or explicit sign-out) before any notice is withdrawn or reposted. */
 public void owner(JSONObject owner)throws Exception{synchronized(LOCK){storage.write(config.ownerSlot,new JSONObject().put("owner",owner==null?JSONObject.NULL:NoticeOwner.identity(owner)).toString());}}
 public boolean ownerMatches(JSONObject route)throws Exception{String raw=storage.read(config.ownerSlot);if(raw==null)return true;return NoticeOwner.matches(new JSONObject(raw).optJSONObject("owner"),route);}
 /** Rotates a route before a quiet repost, so a token captured before suspension can never open it. */
 public void fresh(String id)throws Exception{synchronized(LOCK){JSONObject rows=ledger(),row=rows.getJSONObject(id);row.put("token",UUID.randomUUID().toString()).put("state","new").put("order",0);row.remove("question");storage.write(config.routeSlot,rows.toString());}}
 /** Unexpired suspended approval notices of this owner, with their exact routes for host revalidation. */
 public JSONArray suspendedApprovals(JSONObject owner,long now)throws Exception{synchronized(LOCK){
  JSONArray out=new JSONArray();JSONObject rows=ledger();String raw=storage.read(config.delivery.approvalSlot);JSONObject receipts=raw==null?new JSONObject():new JSONObject(raw);
  for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id),receipt=receipts.optJSONObject(id);if(!NoticeDelivery.approvalId(id)||!NoticeOwner.matches(owner,row.getJSONObject("route"))||receipt==null||!"suspended".equals(receipt.optString("status"))||receipt.getLong("expiresAt")<=now)continue;out.put(new JSONObject().put("id",id).put("bindingHash",row.getString("binding")).put("expiresAt",receipt.getLong("expiresAt")).put("route",row.getJSONObject("route")));}return out;
 }}
 private boolean confirmed(String id,JSONObject row)throws Exception{return confirmed(id,row,row.optBoolean("question"));}
 private boolean confirmed(String id,JSONObject row,boolean question)throws Exception{
  if(!ownerMatches(row.getJSONObject("route")))return false;
  if(NoticeDelivery.approvalId(id)){
   // An approval notice opens its run only while its receipt is posted; a decision or expiry withdraws it.
   String raw=storage.read(config.delivery.approvalSlot);if(raw==null)return false;
   JSONObject receipt=new JSONObject(raw).optJSONObject(id);
   return receipt!=null&&receipt.length()==4&&row.getString("binding").equals(receipt.getString("binding"))&&receipt.getString("digest").matches("[a-f0-9]{64}")&&"succeeded".equals(receipt.getString("status"))&&(!question||receipt.getLong("expiresAt")>System.currentTimeMillis());
  }
  String raw=storage.read(config.delivery.noticeSlot);if(raw==null)return false;
  JSONObject receipt=new JSONObject(raw).optJSONObject(id);
  return receipt!=null&&receipt.length()==3&&row.getString("binding").equals(receipt.getString("binding"))&&receipt.getString("digest").matches("[a-f0-9]{64}")&&"succeeded".equals(receipt.getString("status"));
 }
 public void capture(String token)throws Exception{capture(token,false);}
 /** Durably queues a tap (or an Ask) on a confirmed, current-owner route; repeated taps keep one entry. */
 public void capture(String token,boolean question)throws Exception{synchronized(LOCK){
  if(token==null||!token.matches("[a-f0-9-]{36}"))throw new IllegalArgumentException("Invalid notice tap");
  JSONObject rows=ledger();for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id);if(!token.equals(row.getString("token")))continue;
   if(!confirmed(id,row,question))throw new IllegalStateException("Notification receipt unconfirmed");
   if(!row.getString("state").equals("consumed")){long order=0;for(String key:keys(rows))order=Math.max(order,rows.getJSONObject(key).getLong("order"));row.put("state","pending").put("order",Math.addExact(order,1));if(question){row.put("question",true);}else row.remove("question");storage.write(config.routeSlot,rows.toString());}
   return;
  }throw new UnknownTap();
 }}
 /** The newest pending tap of the current owner, or an empty object. */
 public JSONObject pending()throws Exception{synchronized(LOCK){
  JSONObject rows=ledger(),selected=null;String selectedId=null;long order=-1;
  for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id);if(ownerMatches(row.getJSONObject("route"))&&"pending".equals(row.getString("state"))&&row.getLong("order")>order){selected=row;selectedId=id;order=row.getLong("order");}}
  if(selected==null)return new JSONObject();
  JSONObject result=route(selected.getJSONObject("route"));if(selected.optBoolean("question"))result.put("question",true);
  return result.put("token",selected.getString("token")).put("operationId",selectedId).put("bindingHash",selected.getString("binding")).put("retained",confirmed(selectedId,selected));
 }}
 public void consume(String token)throws Exception{synchronized(LOCK){
  JSONObject rows=ledger();for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id);if(!Objects.equals(token,row.getString("token")))continue;
   if(!"pending".equals(row.getString("state"))||!confirmed(id,row))throw new IllegalStateException("Notification tap changed");
   row.put("state","consumed");storage.write(config.routeSlot,rows.toString());return;
  }throw new UnknownTap();
 }}
 /** Settles a pending Ask tap without consuming its notice: `untapped` returns it to "new" (explicit Cancel),
  * otherwise it keeps its place as a plain open tap (its notice is gone, so there is nothing left to review). */
 public void settleQuestion(String token,boolean untapped)throws Exception{synchronized(LOCK){
  JSONObject rows=ledger();for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id);if(!Objects.equals(token,row.getString("token")))continue;
   if(!"pending".equals(row.getString("state"))||!row.optBoolean("question"))throw new IllegalStateException("Notification tap changed");
   row.remove("question");if(untapped)row.put("state","new").put("order",0);storage.write(config.routeSlot,rows.toString());return;
  }throw new UnknownTap();
 }}
 /** Completes an approval Ask without consuming its route: the approval is still waiting, so its
  * time-sensitive notice stays posted and its tap remains usable. Refuses expired, withdrawn or other-owner routes. */
 public void releaseApprovalQuestion(String token)throws Exception{synchronized(LOCK){
  JSONObject rows=ledger();for(String id:keys(rows)){JSONObject row=rows.getJSONObject(id);if(!Objects.equals(token,row.getString("token")))continue;
   if(!NoticeDelivery.approvalId(id)||!"pending".equals(row.getString("state"))||!row.optBoolean("question")||!confirmed(id,row))throw new IllegalStateException("Notification tap changed");
   row.remove("question");row.put("state","new").put("order",0);storage.write(config.routeSlot,rows.toString());return;
  }throw new UnknownTap();
 }}
 /** All owner-specific routes of other owners, in stable order: results share the same privacy boundary. */
 public List<String> noticesOfOtherOwners(JSONObject owner)throws Exception{synchronized(LOCK){
  NoticeOwner.identity(owner);
  JSONObject rows=ledger();List<String> result=new ArrayList<>();
  for(String id:keys(rows))if(!NoticeOwner.matches(owner,rows.getJSONObject(id).getJSONObject("route")))result.add(id);
  Collections.sort(result);return result;
 }}
 /** Frees a withdrawn or expired approval route. Its receipt is no longer posted, so even a captured tap could never open. */
 public void forget(String id)throws Exception{synchronized(LOCK){
  if(!NoticeDelivery.approvalId(id))throw new IllegalArgumentException("Only approval routes are released");
  JSONObject rows=ledger(),row=rows.optJSONObject(id);if(row==null||confirmed(id,row))return;
  rows.remove(id);storage.write(config.routeSlot,rows.toString());
 }}
}

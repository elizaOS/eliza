package ai.eliza.plugins.notifications;

import java.util.Objects;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Host-level notice operations over one receipt ledger and its route ledger: step and approval posts,
 * withdrawal, the owner privacy fence and the quiet repost when the original owner returns. Receipt
 * semantics stay those of NoticeDelivery: a notice is posted at most once and never reported posted when
 * only queued. Every post holds NoticeDelivery's lock, then the route lock, from prepare to publish, so
 * the sweep that frees room never sees another post between its prepare and its publish. */
public final class NoticeCoordinator {
 /** A host check run after the route is prepared and before anything is recorded or posted. */
 public interface Check {void run()throws Exception;}
 private static final Set<String> LIVE=Set.of("applying","succeeded","unknown","suspended");
 private final NoticeDelivery delivery;private final NoticeRoutes routes;
 public NoticeCoordinator(NoticeDelivery delivery,NoticeRoutes routes){this.delivery=Objects.requireNonNull(delivery);this.routes=Objects.requireNonNull(routes);}
 /** The whole step post: free room, prepare the tap route, run the host check, record and post. A post
  * refused for room resolves failed (nothing was recorded or shown); a refused or failed post releases
  * the route it prepared. */
 public String postStep(String id,String binding,JSONObject route,String title,String body,Check ready)throws Exception{return delivery.exclusive(()->{
  if(NoticeDelivery.approvalId(id))throw new IllegalArgumentException("Approval notices are posted by postApproval");
  routes.retire(id,route,delivery::shown);
  try{routes.prepare(id,binding,route);}catch(NoticeRoutes.Full full){return "failed";}
  String status;
  try{ready.run();status=delivery.publish(id,binding,title,body);}
  catch(Exception refused){release(id);throw refused;}
  if("failed".equals(status))release(id);
  return status;
 });}
 private void release(String id){try{routes.release(id);}catch(Exception kept){/* A route without a receipt is retired by the next sweep. */}}
 /** The whole approval post. The tap route is prepared first because the notice's tap needs it.
  * After a publication failure, only a definitely absent or validated terminal receipt releases it.
  * An unreadable or uncertain receipt keeps its route, and cleanup never replaces the publication error. */
 public String postApproval(String id,String binding,JSONObject route,long expiresAt,long now)throws Exception{return delivery.exclusive(()->{
  if(!NoticeDelivery.approvalId(id)||route==null)throw new IllegalArgumentException("Invalid approval notice identity");
  for(String expired:delivery.expireApprovals(now))routes.forget(expired);
  if(delivery.approvalTimeout(expiresAt,now)<=0)return "expired";
  if(!routes.ownerMatches(route))return "owner-changed";
  routes.retire(id,route,delivery::shown);
  routes.prepare(id,binding,route);
  String status;
  try{status=delivery.publishApproval(id,binding,expiresAt,now);}
  catch(Exception refused){
   try{
    String retained=delivery.approvalStatus(id,binding,expiresAt);
    // An absent or terminal receipt is definite; an unreadable or live one keeps its route.
    if(retained==null||"failed".equals(retained)||"withdrawn".equals(retained))routes.forget(id);
   }catch(Exception cleanup){if(cleanup!=refused)refused.addSuppressed(cleanup);}
   throw refused;
  }
  if(!LIVE.contains(status))routes.forget(id);
  return status;
 });}
 /** The whole withdrawal. The ledger refuses a withdrawal it cannot record (a full or unreadable ledger);
  * the route is released all the same unless its receipt is still posted, so a decided approval never
  * keeps a route that no later call would free. */
 public void withdrawApproval(String id,long now)throws Exception{try{delivery.withdrawApproval(id,now);}finally{routes.forget(id);}}
 /** Persist the privacy fence before touching OS notices. Approvals of other owners are suspended (their
  * owner may return); results are withdrawn. Repeated calls complete an interrupted cancellation. */
 public int withdrawOtherOwners(JSONObject owner,long now)throws Exception{
  routes.owner(owner);Exception first=null;int withdrawn=0;
  for(String id:routes.noticesOfOtherOwners(owner)){try{if(NoticeDelivery.approvalId(id))delivery.suspendApproval(id,now);else delivery.withdraw(id);withdrawn++;}catch(Exception failure){if(first==null)first=failure;}}
  if(first!=null)throw first;return withdrawn;
 }
 /** Caller revalidated the exact pending approval without authorizing it. Rotate its tap before quiet dispatch. */
 public String resumeApproval(String id,String binding,JSONObject route,long expiresAt,long now)throws Exception{return delivery.exclusive(()->{
  if(!routes.ownerMatches(route))return "owner-changed";
  boolean suspended=false;JSONArray retained=routes.suspendedApprovals(NoticeOwner.fromRoute(route),now);
  for(int i=0;i<retained.length();i++)if(id.equals(retained.getJSONObject(i).getString("id")))suspended=true;
  if(!suspended)return "not-suspended";
  routes.prepare(id,binding,route);routes.fresh(id);
  return delivery.resumeApproval(id,binding,expiresAt,now);
 });}
}

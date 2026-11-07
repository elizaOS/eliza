package ai.eliza.plugins.notifications;

import java.util.Objects;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Host-level approval notice operations over one receipt ledger and its route ledger: post, withdraw,
 * the owner privacy fence and the quiet repost when the original owner returns. Receipt semantics stay
 * those of NoticeDelivery: a notice is posted at most once and never reported posted when only queued. */
public final class NoticeCoordinator {
 private final NoticeDelivery delivery;private final NoticeRoutes routes;
 public NoticeCoordinator(NoticeDelivery delivery,NoticeRoutes routes){this.delivery=Objects.requireNonNull(delivery);this.routes=Objects.requireNonNull(routes);}
 /** The whole approval post. The tap route is prepared first because the notice's tap needs it. A route
  * whose receipt is not live afterwards (withdrawn, failed) is released again: a repeated request for
  * a decided approval must not keep a route that no notice can ever open. */
 public String postApproval(String id,String binding,JSONObject route,long expiresAt,long now)throws Exception{
  if(!NoticeDelivery.approvalId(id)||route==null)throw new IllegalArgumentException("Invalid approval notice identity");
  for(String expired:delivery.expireApprovals(now))routes.forget(expired);
  if(delivery.approvalTimeout(expiresAt,now)<=0)return "expired";
  if(!routes.ownerMatches(route))return "owner-changed";
  routes.prepare(id,binding,route);
  String status=delivery.publishApproval(id,binding,expiresAt,now);
  if(!Set.of("applying","succeeded","unknown","suspended").contains(status))routes.forget(id);
  return status;
 }
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
 public String resumeApproval(String id,String binding,JSONObject route,long expiresAt,long now)throws Exception{
  if(!routes.ownerMatches(route))return "owner-changed";
  boolean suspended=false;JSONArray retained=routes.suspendedApprovals(NoticeOwner.fromRoute(route),now);
  for(int i=0;i<retained.length();i++)if(id.equals(retained.getJSONObject(i).getString("id")))suspended=true;
  if(!suspended)return "not-suspended";
  routes.prepare(id,binding,route);routes.fresh(id);
  return delivery.resumeApproval(id,binding,expiresAt,now);
 }
}

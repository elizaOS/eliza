import ai.eliza.plugins.notifications.NoticeCoordinator;
import ai.eliza.plugins.notifications.NoticeDelivery;
import ai.eliza.plugins.notifications.NoticeOwner;
import ai.eliza.plugins.notifications.NoticeRecovery;
import ai.eliza.plugins.notifications.NoticeRoutes;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** JVM checks of the host notice routes, approval coordination and journal recovery with an in-memory
 * store, a synthetic poster and synthetic identifiers only; no Android framework. */
public final class NoticeHostTest {
 private static int checks;
 private static void check(boolean value){checks++;if(!value)throw new AssertionError("Check "+checks);}
 private interface Failing{void run()throws Exception;}
 private static void rejects(Failing action)throws Exception{checks++;try{action.run();}catch(IllegalStateException|IllegalArgumentException expected){return;}throw new AssertionError("Expected refusal at check "+checks);}
 static final class Store implements NoticeDelivery.Storage{final Map<String,String> values=new HashMap<>();boolean fail;public String read(String slot){return values.get(slot);}public void write(String slot,String value){if(fail)throw new IllegalStateException("disk");values.put(slot,value);}}
 static final class Poster implements NoticeDelivery.Poster{
  int posts,quiet;final Map<String,String> active=new HashMap<>();final List<String> cancelled=new ArrayList<>();
  public boolean allowed(){return true;}
  public void post(String id,String title,String body){posts++;active.put(id,title+"\n"+body);}
  public void postApproval(String id,String title,String body,long timeout){posts++;active.put(id,title+"\n"+body);}
  public void postApprovalQuiet(String id,String title,String body,long timeout){quiet++;postApproval(id,title,body,timeout);}
  public void cancel(String id){cancelled.add(id);active.remove(id);}
  public boolean matches(String id,String title,String body){return Objects.equals(active.get(id),title+"\n"+body);}
 }
 static final NoticeDelivery.Config DELIVERY=new NoticeDelivery.Config("host-notices:v1","host-approvals:v1","Step waiting for approval","Open the app to review it.",7L*86400000);
 static final NoticeRoutes.Config ROUTES=new NoticeRoutes.Config("host-routes:v1","host-owner:v1",DELIVERY,"workflowId","runId","versionId");
 static JSONObject route(String owner,String run)throws Exception{return new JSONObject().put("scope","a".repeat(64)).put("origin","https://agent.invalid").put("ownerId",owner).put("agentId","agent").put("workflowId","workflow").put("runId",run).put("versionId","v1");}
 static String hash(JSONArray parts)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(parts.toString().getBytes(StandardCharsets.UTF_8)))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
 public static void main(String[] args)throws Exception{
  // Configuration keeps routes, owner fence and receipts in distinct deployed slots.
  rejects(()->new NoticeRoutes.Config("host-notices:v1","host-owner:v1",DELIVERY,"runId"));
  rejects(()->new NoticeRoutes.Config("host-routes:v1","host-owner:v1",DELIVERY,"ownerId"));
  rejects(()->new NoticeRoutes.Config("host-routes:v1","host-owner:v1",DELIVERY,"runId","runId"));
  String binding="b".repeat(64);
  // A step route opens only while its notice receipt is posted; a tap is queued durably and consumed once.
  Store store=new Store();Poster poster=new Poster();NoticeDelivery delivery=new NoticeDelivery(DELIVERY,store,poster);NoticeRoutes routes=new NoticeRoutes(store,ROUTES);
  String token=routes.prepare("step-1",binding,route("owner","run-1"));check(token.equals(routes.prepare("step-1",binding,route("owner","run-1"))));
  rejects(()->routes.prepare("step-1",binding,route("owner","run-2")));
  rejects(()->routes.prepare("step-2",binding,new JSONObject(route("owner","run-2").toString()).put("extra","x")));
  rejects(()->routes.capture(token));
  check("succeeded".equals(delivery.publish("step-1",binding,"Result","Body")));
  routes.capture(token);JSONObject pending=new NoticeRoutes(store,ROUTES).pending();check("run-1".equals(pending.getString("runId"))&&pending.getBoolean("retained"));
  store.fail=true;rejects(()->routes.consume(token));store.fail=false;routes.consume(token);check(routes.pending().length()==0);
  boolean unknown=false;try{routes.capture(UUID.randomUUID().toString());}catch(NoticeRoutes.UnknownTap expected){unknown=true;}check(unknown);
  // Approvals: one notice per approval, owner fence suspends instead of withdrawing, return reposts quietly.
  NoticeCoordinator coordinator=new NoticeCoordinator(delivery,routes);long now=1_760_000_000_000L,minute=60000L;
  String approval="approval-"+"1".repeat(64),other="approval-"+"2".repeat(64);
  check("succeeded".equals(coordinator.postApproval(approval,binding,route("owner","run-a"),now+10*minute,now)));
  check("succeeded".equals(coordinator.postApproval(approval,binding,route("owner","run-a"),now+10*minute,now+minute))&&poster.posts==2);
  check("expired".equals(coordinator.postApproval(other,binding,route("owner","run-b"),now,now)));check(routes.token(other)==null);
  check(coordinator.withdrawOtherOwners(NoticeOwner.fromRoute(route("second","x")),now+minute)==2);
  check(!poster.active.containsKey(approval)&&!poster.active.containsKey("step-1"));
  check("owner-changed".equals(coordinator.postApproval(other,binding,route("owner","run-b"),now+10*minute,now+minute)));
  check(routes.pending().length()==0);
  JSONArray suspended=routes.suspendedApprovals(NoticeOwner.fromRoute(route("owner","x")),now+minute);check(suspended.length()==1&&approval.equals(suspended.getJSONObject(0).getString("id")));
  check("owner-changed".equals(coordinator.resumeApproval(approval,binding,route("owner","run-a"),now+10*minute,now+2*minute)));
  String before=routes.token(approval);coordinator.withdrawOtherOwners(NoticeOwner.fromRoute(route("owner","x")),now+2*minute);
  check("succeeded".equals(coordinator.resumeApproval(approval,binding,route("owner","run-a"),now+10*minute,now+2*minute))&&poster.quiet==1);
  check(!before.equals(routes.token(approval)));
  check("not-suspended".equals(coordinator.resumeApproval(approval,binding,route("owner","run-a"),now+10*minute,now+3*minute)));
  // A decision withdraws the notice for good and frees its route.
  coordinator.withdrawApproval(approval,now+3*minute);check(routes.token(approval)==null&&poster.cancelled.contains(approval));
  check("withdrawn".equals(coordinator.postApproval(approval,binding,route("owner","run-a"),now+10*minute,now+4*minute)));check(routes.token(approval)==null);
  // Journal recovery promotes an admitted attempt only from its original receipt and never reposts.
  String scope="c".repeat(64),proposal="proposal",operationId="notice";
  JSONObject operation=new JSONObject().put("type","post_notification").put("title","Reviewed title").put("body","Reviewed body");
  JSONObject record=new JSONObject().put("ownerId","owner").put("agentId","agent").put("sessionId","session").put("origin","https://agent.invalid").put("installationId","installation").put("enrollmentId","enrollment").put("digest","digest").put("operation",operation).put("workflow",new JSONObject().put("runId","run"));
  JSONObject entry=new JSONObject().put("scope",scope).put("proposalId",proposal).put("operationId",operationId).put("record",record).put("phase","applying").put("attemptId","attempt");
  String recoveryBinding=hash(new JSONArray().put(scope).put("owner").put("agent").put("session").put("https://agent.invalid").put("installation").put("enrollment").put(proposal).put("digest").put(operationId));
  check(recoveryBinding.equals(NoticeRecovery.binding(entry,scope,proposal)));
  Store journalStore=new Store();Poster journalPoster=new Poster();NoticeDelivery journal=new NoticeDelivery(DELIVERY,journalStore,journalPoster);
  check(NoticeRecovery.recover(entry,scope,proposal,recoveryBinding,journal::receipt)==entry&&journalPoster.posts==0);
  journal.publish(operationId,recoveryBinding,"Reviewed title","Reviewed body");journalPoster.active.clear();
  JSONObject recovered=NoticeRecovery.recover(entry,scope,proposal,recoveryBinding,journal::receipt);check("succeeded".equals(recovered.getString("status"))&&journalPoster.posts==1);
  JSONObject changed=new JSONObject(entry.toString());changed.getJSONObject("record").put("sessionId","other");rejects(()->NoticeRecovery.recover(changed,scope,proposal,recoveryBinding,journal::receipt));
  JSONObject reserved=new JSONObject(entry.toString()).put("phase","reserved");rejects(()->NoticeRecovery.recover(reserved,scope,proposal,recoveryBinding,journal::receipt));
  System.out.println(checks+" assertions passed");
 }
}

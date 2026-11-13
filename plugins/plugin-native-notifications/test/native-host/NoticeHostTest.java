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
import java.util.Set;
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
 static class Store implements NoticeDelivery.Storage{final Map<String,String> values=new HashMap<>();boolean fail;public String read(String slot){return values.get(slot);}public void write(String slot,String value){if(fail)throw new IllegalStateException("disk");values.put(slot,value);}}
 static final class Poster implements NoticeDelivery.Poster{
  int posts,quiet;final Map<String,String> active=new HashMap<>();final List<String> cancelled=new ArrayList<>();
  public boolean allowed(){return true;}
  // Like Android, keeps at most 1024 characters of text.
  public void post(String id,String title,String body){posts++;active.put(id,title+"\n"+body.substring(0,Math.min(body.length(),1024)));}
  public void postApproval(String id,String title,String body,long timeout){posts++;active.put(id,title+"\n"+body);}
  public void postApprovalQuiet(String id,String title,String body,long timeout){quiet++;postApproval(id,title,body,timeout);}
  public void cancel(String id){cancelled.add(id);active.remove(id);}
  public boolean matches(String id,String title,String body){String shown=active.get(id);return shown!=null&&shown.startsWith(title+"\n")&&NoticeDelivery.sameText(body,shown.substring(title.length()+1));}
  public boolean shown(String id){return active.containsKey(id);}
  public String[] shownText(String id){String shown=active.get(id);return shown==null?null:shown.split("\n",2);}
 }
 static final NoticeDelivery.Config DELIVERY=new NoticeDelivery.Config("host-notices:v1","host-approvals:v1","Step waiting for approval","Open the app to review it.",7L*86400000);
 static final NoticeRoutes.Config ROUTES=new NoticeRoutes.Config("host-routes:v1","host-owner:v1",DELIVERY,"workflowId","runId","versionId");
 static JSONObject route(String owner,String run)throws Exception{return new JSONObject().put("scope","a".repeat(64)).put("origin","https://agent.invalid").put("ownerId",owner).put("agentId","agent").put("workflowId","workflow").put("runId",run).put("versionId","v1");}
 static String hash(JSONArray parts)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(parts.toString().getBytes(StandardCharsets.UTF_8)))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
 private static void sameFailure(Exception original,Failing work)throws Exception{checks++;try{work.run();}catch(Exception failure){if(failure==original)return;throw new AssertionError("Original publish failure changed",failure);}throw new AssertionError("Expected original publish failure");}
 private static void approvalFailureCleanup(String binding,long now,long minute)throws Exception{
  String id="approval-"+"f".repeat(64);
  Store full=new Store(){public void write(String slot,String value){if("host-approvals:v1".equals(slot))throw new AssertionError("Full ledger wrote a new approval");super.write(slot,value);}};
  JSONObject rows=new JSONObject();for(int i=0;i<256;i++)rows.put("approval-"+String.format("%064x",i),new JSONObject().put("status","withdrawn").put("expiresAt",now+minute));
  String retained=rows.toString();full.values.put("host-approvals:v1",retained);Poster silent=new Poster();
  for(int attempt=0;attempt<3;attempt++){
   NoticeRoutes routes=new NoticeRoutes(full,ROUTES);NoticeCoordinator coordinator=new NoticeCoordinator(new NoticeDelivery(DELIVERY,full,silent),routes);
   try{coordinator.postApproval(id,binding,route("owner","full"),now+minute,now);throw new AssertionError("Expected full approval history");}
   catch(IllegalStateException failure){check(failure.getClass()==IllegalStateException.class&&failure.getMessage().contains("history is full"));}
   check(routes.token(id)==null&&routes.pending().length()==0&&retained.equals(full.values.get("host-approvals:v1"))&&silent.posts==0&&silent.cancelled.isEmpty());
  }
  String exactDigest=hash(new JSONArray().put("Step waiting for approval").put("Open the app to review it."));
  // A publish that leaves malformed or foreign storage has no definite cleanup decision.
  for(Object damaged:new Object[]{"not-an-object",new JSONObject().put("status","failed").put("expiresAt",now+minute),new JSONObject().put("status","failed").put("binding",binding).put("digest","0".repeat(64)).put("expiresAt",now+minute),new JSONObject().put("status","withdrawn").put("expiresAt","not-a-time"),new JSONObject().put("status","failed").put("binding","e".repeat(64)).put("digest",exactDigest).put("expiresAt",now+minute),new JSONObject().put("status","failed").put("binding",binding).put("digest",exactDigest).put("expiresAt",now+2*minute)}){
   IllegalStateException original=new IllegalStateException("Claim outcome unavailable");
   Store fault=new Store(){public void write(String slot,String value){if("host-approvals:v1".equals(slot)){values.put(slot,new JSONObject().put(id,damaged).toString());throw original;}super.write(slot,value);}};
   Poster poster=new Poster();NoticeRoutes routes=new NoticeRoutes(fault,ROUTES);NoticeCoordinator coordinator=new NoticeCoordinator(new NoticeDelivery(DELIVERY,fault,poster),routes);
   sameFailure(original,()->coordinator.postApproval(id,binding,route("owner","corrupt"),now+minute,now));
   check(original.getSuppressed().length==1&&routes.token(id)!=null&&poster.posts==0);
   check(new JSONObject(fault.values.get("host-approvals:v1")).get(id).toString().equals(damaged.toString()));
  }
  // Only validated terminal observations can release a route after a lost publication reply.
  for(String status:new String[]{"failed","withdrawn","withdrawal-intent"}){
   IllegalStateException original=new IllegalStateException("Terminal receipt committed before lost reply");
   JSONObject terminal=status.equals("withdrawal-intent")?new JSONObject().put("status","withdrawn").put("expiresAt",now+minute):new JSONObject().put("status",status).put("binding",binding).put("digest",exactDigest).put("expiresAt",now+minute);
   Store fault=new Store(){public void write(String slot,String value){if("host-approvals:v1".equals(slot)){values.put(slot,new JSONObject().put(id,terminal).toString());throw original;}super.write(slot,value);}};
   Poster poster=new Poster();NoticeRoutes routes=new NoticeRoutes(fault,ROUTES);NoticeCoordinator coordinator=new NoticeCoordinator(new NoticeDelivery(DELIVERY,fault,poster),routes);
   sameFailure(original,()->coordinator.postApproval(id,binding,route("owner","terminal"),now+minute,now));
   check(original.getSuppressed().length==0&&routes.token(id)==null&&poster.posts==0);
   check(new JSONObject(fault.values.get("host-approvals:v1")).getJSONObject(id).toString().equals(terminal.toString()));
  }
  // A committed applying claim remains uncertain and must never post on retry.
  {IllegalStateException original=new IllegalStateException("Claim committed before lost reply");boolean[] cut={true};
   Store fault=new Store(){public void write(String slot,String value){super.write(slot,value);if(cut[0]&&"host-approvals:v1".equals(slot)){cut[0]=false;throw original;}}};
   Poster poster=new Poster();NoticeRoutes routes=new NoticeRoutes(fault,ROUTES);NoticeCoordinator coordinator=new NoticeCoordinator(new NoticeDelivery(DELIVERY,fault,poster),routes);
   sameFailure(original,()->coordinator.postApproval(id,binding,route("owner","uncertain"),now+minute,now));String token=routes.token(id);
   check(token!=null&&poster.posts==0&&"applying".equals(new JSONObject(fault.values.get("host-approvals:v1")).getJSONObject(id).getString("status")));
   check("unknown".equals(coordinator.postApproval(id,binding,route("owner","uncertain"),now+minute,now))&&token.equals(routes.token(id))&&poster.posts==0);
  }
  // Failed cleanup reads and writes preserve the exact original publish error.
  for(boolean readFailure:new boolean[]{true,false}){
   IllegalStateException original=new IllegalStateException("Claim refused"),cleanup=new IllegalStateException("Cleanup unavailable");boolean[] refused={false};
   Store fault=new Store(){public String read(String slot){if(refused[0]&&readFailure&&"host-approvals:v1".equals(slot))throw cleanup;return super.read(slot);}public void write(String slot,String value){if("host-approvals:v1".equals(slot)){refused[0]=true;throw original;}if(refused[0]&&!readFailure&&"host-routes:v1".equals(slot))throw cleanup;super.write(slot,value);}};
   Poster poster=new Poster();NoticeRoutes routes=new NoticeRoutes(fault,ROUTES);NoticeCoordinator coordinator=new NoticeCoordinator(new NoticeDelivery(DELIVERY,fault,poster),routes);
   sameFailure(original,()->coordinator.postApproval(id,binding,route("owner","cleanup"),now+minute,now));
   check(original.getSuppressed().length==1&&original.getSuppressed()[0]==cleanup&&routes.token(id)!=null&&poster.posts==0&&!fault.values.containsKey("host-approvals:v1"));
  }
 }
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
  approvalFailureCleanup(binding,now,minute);
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
  // Retention: a full ledger retires, oldest first, settled receipts of notices Android no longer shows,
  // with their routes. A pending tap, an applying or unknown receipt and a shown notice stay.
  Store kept=new Store();Poster keptPoster=new Poster();long[] clock={now};NoticeCoordinator.Check ready=()->{};
  NoticeDelivery capped=new NoticeDelivery(DELIVERY,kept,keptPoster,()->clock[0]);NoticeRoutes cappedRoutes=new NoticeRoutes(kept,ROUTES,()->clock[0]);NoticeCoordinator posts=new NoticeCoordinator(capped,cappedRoutes);
  // Rows written before retention (no creation time) still load, and retire first.
  String legacyToken=UUID.randomUUID().toString();
  kept.values.put("host-notices:v1",new JSONObject().put("legacy",new JSONObject().put("binding",binding).put("digest","d".repeat(64)).put("status","succeeded")).toString());
  kept.values.put("host-routes:v1",new JSONObject().put("legacy",new JSONObject().put("binding",binding).put("route",route("owner","run-legacy")).put("token",legacyToken).put("state","new").put("order",0)).toString());
  check(legacyToken.equals(cappedRoutes.token("legacy")));
  // An approval route whose publish never ran (process death) has no receipt and is freed by the sweep.
  String orphan="approval-"+"3".repeat(64);cappedRoutes.prepare(orphan,binding,route("owner","run-orphan"));
  // While every notice is still shown nothing settles: once the row or byte bound is reached a post resolves
  // failed, posts nothing and keeps no route. The sweep before it freed the legacy and orphaned rows.
  int filled=0;String status;
  do{clock[0]+=minute;status=posts.postStep("step-"+filled,binding,route("owner","run-"+filled),"Result","Body",ready);filled++;}while("succeeded".equals(status)&&filled<=NoticeDelivery.MAX_RECEIPTS);
  String full="step-"+(filled-1);check("failed".equals(status)&&filled>100&&keptPoster.posts==filled-1);
  check(cappedRoutes.token(full)==null&&!new JSONObject(kept.values.get("host-notices:v1")).has(full));
  check(cappedRoutes.token("legacy")==null&&cappedRoutes.token(orphan)==null&&!new JSONObject(kept.values.get("host-notices:v1")).has("legacy"));
  check(kept.values.get("host-routes:v1").getBytes(StandardCharsets.UTF_8).length<=NoticeRoutes.MAX_BYTES);
  // A tapped notice, an applying and an unknown receipt and a still-shown notice stay; dismissed settled ones go.
  cappedRoutes.capture(cappedRoutes.token("step-0"));
  JSONObject receipts=new JSONObject(kept.values.get("host-notices:v1"));receipts.getJSONObject("step-1").put("status","applying");receipts.getJSONObject("step-2").put("status","unknown");kept.values.put("host-notices:v1",receipts.toString());
  keptPoster.active.keySet().retainAll(Set.of("step-0","step-3"));
  for(int i=0;i<200;i++){check("succeeded".equals(posts.postStep("next-"+i,binding,route("owner","next-"+i),"Result","Body",ready)));keptPoster.active.remove("next-"+i);}
  receipts=new JSONObject(kept.values.get("host-notices:v1"));
  for(String id:new String[]{"step-0","step-1","step-2","step-3"})check(receipts.has(id)&&cappedRoutes.token(id)!=null);
  check(!receipts.has("step-4")&&cappedRoutes.token("step-4")==null&&receipts.length()<=NoticeDelivery.MAX_RECEIPTS);
  JSONObject live=cappedRoutes.pending();check("run-0".equals(live.getString("runId"))&&live.getBoolean("retained"));
  // A refused host check releases the prepared route and records nothing.
  rejects(()->posts.postStep("step-refused",binding,route("owner","run-refused"),"Result","Body",()->{throw new IllegalStateException("locked");}));
  check(cappedRoutes.token("step-refused")==null&&!new JSONObject(kept.values.get("host-notices:v1")).has("step-refused"));
  cappedRoutes.release("step-3");check(cappedRoutes.token("step-3")!=null);
  rejects(()->cappedRoutes.release(approval));
  // Routes stay below the byte bound even when every origin has the maximum length.
  Store wide=new Store();Poster widePoster=new Poster();NoticeDelivery wideDelivery=new NoticeDelivery(DELIVERY,wide,widePoster);NoticeRoutes wideRoutes=new NoticeRoutes(wide,ROUTES);NoticeCoordinator widePosts=new NoticeCoordinator(wideDelivery,wideRoutes);
  String origin="https://"+"o".repeat(2040);int refused=0;
  for(int i=0;i<200;i++){
   String wideStatus=widePosts.postStep("wide-"+i,binding,route("owner","wide-"+i).put("origin",origin),"Result","Body",ready);if("failed".equals(wideStatus))refused++;
   check(wide.values.get("host-routes:v1").getBytes(StandardCharsets.UTF_8).length<=NoticeRoutes.MAX_BYTES);
  }
  check(refused>0);widePoster.active.clear();
  check("succeeded".equals(widePosts.postStep("wide-again",binding,route("owner","wide-again").put("origin",origin),"Result","Body",ready)));
  // A body over Android's 1024-character text limit is shown as its prefix, recorded succeeded and its tap opens.
  Store longStore=new Store();Poster longPoster=new Poster();NoticeDelivery longDelivery=new NoticeDelivery(DELIVERY,longStore,longPoster);NoticeRoutes longRoutes=new NoticeRoutes(longStore,ROUTES);NoticeCoordinator longPosts=new NoticeCoordinator(longDelivery,longRoutes);
  String longBody="x".repeat(1500);
  check("succeeded".equals(longPosts.postStep("long",binding,route("owner","run-long"),"Result",longBody,ready))&&"succeeded".equals(longDelivery.receipt("long",binding,"Result",longBody)));
  longRoutes.capture(longRoutes.token("long"));check(longRoutes.pending().getBoolean("retained"));
  check(!NoticeDelivery.sameText(longBody,"x".repeat(1023))&&!NoticeDelivery.sameText("x".repeat(1024),"x".repeat(1023)));
  // The owner fence can withdraw a notice before it is recorded: the tombstone keeps a later publish from posting.
  longDelivery.withdraw("fenced");check(new JSONObject(longStore.values.get("host-notices:v1")).getJSONObject("fenced").length()==2);
  int shownBefore=longPoster.posts;check("withdrawn".equals(longPosts.postStep("fenced",binding,route("owner","run-fenced"),"Result","Body",ready))&&longPoster.posts==shownBefore);
  check("withdrawn".equals(longDelivery.receipt("fenced",binding,"Result","Body")));
  // A pending tap whose notice was withdrawn settles, so older taps are reachable again.
  check("succeeded".equals(longPosts.postStep("older",binding,route("owner","run-older"),"Result","Body",ready))&&"succeeded".equals(longPosts.postStep("newer",binding,route("owner","run-newer"),"Result","Body",ready)));
  longRoutes.consume(longRoutes.pending().getString("token"));
  longRoutes.capture(longRoutes.token("older"));longRoutes.capture(longRoutes.token("newer"));check("run-newer".equals(longRoutes.pending().getString("runId")));
  longDelivery.withdraw("newer");check("run-older".equals(longRoutes.pending().getString("runId")));
  // A tap the renderer found definitively unavailable is discarded; one whose receipt is uncertain stays.
  String olderToken=longRoutes.token("older");JSONObject uncertain=new JSONObject(longStore.values.get("host-notices:v1"));uncertain.getJSONObject("older").put("status","unknown");longStore.values.put("host-notices:v1",uncertain.toString());
  rejects(()->longRoutes.discard(olderToken));uncertain.getJSONObject("older").put("status","succeeded");longStore.values.put("host-notices:v1",uncertain.toString());
  check("older".equals(longRoutes.discard(olderToken))&&longRoutes.pending().length()==0);
  rejects(()->longRoutes.discard(olderToken));
  System.out.println(checks+" assertions passed");
 }
}

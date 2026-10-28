import ai.eliza.plugins.notifications.NoticeCoordinator;
import ai.eliza.plugins.notifications.NoticeDelivery;
import ai.eliza.plugins.notifications.NoticeRoutes;
import ai.eliza.plugins.notifications.NoticeTapInbox;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.json.JSONObject;

/** JVM checks of the notice tap inbox with synthetic intents, an in-memory store and a synthetic poster:
 * intent identity, durable capture with retry, Ask settlement and consumption. No Android framework. */
public final class NoticeTapInboxTest {
 private static int checks;
 private static void check(boolean value){checks++;if(!value)throw new AssertionError("Check "+checks);}
 private interface Failing{void run()throws Exception;}
 private static void rejects(Failing action)throws Exception{checks++;try{action.run();}catch(IllegalStateException|IllegalArgumentException expected){return;}throw new AssertionError("Expected refusal at check "+checks);}
 /** A launch intent: identity matters, as with Android Intent objects. */
 static final class Intent{String action,data;Intent(String action,String data){this.action=action;this.data=data;}}
 static final NoticeTapInbox.Intents<Intent> INTENTS=new NoticeTapInbox.Intents<>(){public String action(Intent intent){return intent.action;}public String data(Intent intent){return intent.data;}};
 static final class Store implements NoticeDelivery.Storage{final Map<String,String> values=new HashMap<>();boolean fail;public String read(String slot){return values.get(slot);}public void write(String slot,String value){if(fail)throw new IllegalStateException("disk");values.put(slot,value);}}
 static final class Poster implements NoticeDelivery.Poster{
  final Map<String,String> active=new HashMap<>();
  public boolean allowed(){return true;}
  public void post(String id,String title,String body){active.put(id,title+"\n"+body);}
  public void postApproval(String id,String title,String body,long timeout){active.put(id,title+"\n"+body);}
  public void cancel(String id){active.remove(id);}
  public boolean matches(String id,String title,String body){return Objects.equals(active.get(id),title+"\n"+body);}
 }
 static final String OPEN="example.OPEN_NOTICE",ASK="example.ASK_NOTICE",PREFIX="example-notice:";
 static final NoticeDelivery.Config DELIVERY=new NoticeDelivery.Config("host-notices:v1","host-approvals:v1","Step waiting for approval","Open the app to review it.",7L*86400000);
 static final NoticeRoutes.Config ROUTES=new NoticeRoutes.Config("host-routes:v1","host-owner:v1",DELIVERY,"workflowId","runId","versionId");
 static JSONObject route(String run)throws Exception{return new JSONObject().put("scope","a".repeat(64)).put("origin","https://agent.invalid").put("ownerId","owner").put("agentId","agent").put("workflowId","workflow").put("runId",run).put("versionId","v1");}
 public static void main(String[] args)throws Exception{
  rejects(()->new NoticeTapInbox<Intent>(new NoticeRoutes(new Store(),ROUTES),OPEN,OPEN,PREFIX));
  Store store=new Store();Poster poster=new Poster();NoticeDelivery delivery=new NoticeDelivery(DELIVERY,store,poster);NoticeRoutes routes=new NoticeRoutes(store,ROUTES);
  NoticeTapInbox<Intent> inbox=new NoticeTapInbox<>(routes,OPEN,ASK,PREFIX);
  String binding="b".repeat(64),token=routes.prepare("step-1",binding,route("run-1"));
  check("succeeded".equals(delivery.publish("step-1",binding,"Result","Body")));
  List<String> cleared=new ArrayList<>();
  NoticeTapInbox.Captured<Intent> clear=(intent,captured)->{cleared.add(captured);if(inbox.data(captured).equals(intent.data))intent.data=null;inbox.release(intent,captured);};
  NoticeTapInbox.QuestionNotice none=pending->{};
  // Only this host's notice intents are taps, and one intent object is queued once until its capture clears.
  check(inbox.retain(new Intent("android.intent.action.MAIN",PREFIX+token),INTENTS)==null);
  check(inbox.retain(new Intent(OPEN,"other:"+token),INTENTS)==null);
  check(inbox.retain(new Intent(OPEN,PREFIX+"not-a-token"),INTENTS)==null);
  Intent tap=new Intent(OPEN,PREFIX+token);String key=inbox.retain(tap,INTENTS);check(token.equals(key));
  check(inbox.retain(tap,INTENTS)==null);
  Intent again=new Intent(OPEN,PREFIX+token);check(token.equals(inbox.retain(again,INTENTS)));
  // A failed durable write keeps the intent retained and reports the tap unavailable, never "no tap".
  store.fail=true;check(inbox.offer(key,tap,clear)==1);check(cleared.isEmpty()&&tap.data!=null);
  rejects(()->inbox.pending(clear,none));
  store.fail=false;check(inbox.offer(key,again,clear)==0);check(cleared.size()==2&&tap.data==null&&again.data==null);
  check(token.equals(inbox.retain(new Intent(OPEN,PREFIX+token),INTENTS)));
  JSONObject pending=inbox.pending(clear,none);check(token.equals(pending.getString("token"))&&"run-1".equals(pending.getString("runId"))&&pending.getBoolean("retained"));
  // Consumption needs the exact pending tap and the foreground; it returns the notice to cancel.
  rejects(()->inbox.consume("other",false,null,none,()->{}));
  rejects(()->inbox.consume(token,false,"revision",none,()->{}));
  rejects(()->inbox.consume(token,true,null,none,()->{}));
  rejects(()->inbox.consume(token,false,null,none,()->{throw new IllegalStateException("locked");}));
  check(routes.pending().has("token"));
  check("step-1".equals(inbox.consume(token,false,null,none,()->{})));check(routes.pending().length()==0);
  // An unknown route is dropped and its intent cleared; nothing can open it.
  Intent unknown=new Intent(OPEN,PREFIX+"00000000-0000-4000-8000-000000000000");String unknownKey=inbox.retain(unknown,INTENTS);
  check(inbox.offer(unknownKey,unknown,clear)==0&&unknown.data==null);check(inbox.pending(clear,none).length()==0);
  // An Ask shows its still-posted notice; one whose notice is gone settles into a plain open tap.
  String second=routes.prepare("step-2",binding,route("run-2"));check("succeeded".equals(delivery.publish("step-2",binding,"Second","Body")));
  Intent ask=new Intent(ASK,PREFIX+second);String askKey=inbox.retain(ask,INTENTS);check((second+":ask").equals(askKey));
  check(inbox.offer(askKey,ask,clear)==0);
  NoticeTapInbox.QuestionNotice posted=row->row.put("notice",new JSONObject().put("id","n").put("revision","r1").put("title","Second").put("text","Body"));
  JSONObject question=inbox.pending(clear,posted);check(question.getBoolean("question")&&"r1".equals(question.getJSONObject("notice").getString("revision")));
  rejects(()->inbox.consume(second,false,"r0",posted,()->{}));
  rejects(()->inbox.consume(second,false,null,posted,()->{}));
  // An explicit Cancel returns it untapped; nothing is cancelled or opened.
  check(inbox.consume(second,true,null,posted,()->{})==null);check(routes.pending().length()==0);
  Intent askAgain=new Intent(ASK,PREFIX+second);check(inbox.offer(inbox.retain(askAgain,INTENTS),askAgain,clear)==0);
  JSONObject settled=inbox.pending(clear,none);check(second.equals(settled.getString("token"))&&!settled.optBoolean("question"));
  check("step-2".equals(inbox.consume(second,false,null,none,()->{})));
  // A completed approval Ask keeps the approval waiting: its notice and tap stay usable.
  NoticeCoordinator coordinator=new NoticeCoordinator(delivery,routes);long now=System.currentTimeMillis();String approval="approval-"+"1".repeat(64);
  check("succeeded".equals(coordinator.postApproval(approval,binding,route("run-3"),now+600000,now)));
  String approvalToken=routes.token(approval);Intent approvalAsk=new Intent(ASK,PREFIX+approvalToken);
  check(inbox.offer(inbox.retain(approvalAsk,INTENTS),approvalAsk,clear)==0);
  check(inbox.pending(clear,posted).getBoolean("question"));
  check(inbox.consume(approvalToken,false,"r1",posted,()->{})==null);
  check(routes.pending().length()==0&&approvalToken.equals(routes.token(approval)));
  Intent approvalOpen=new Intent(OPEN,PREFIX+approvalToken);check(inbox.offer(inbox.retain(approvalOpen,INTENTS),approvalOpen,clear)==0);
  check(approval.equals(inbox.consume(approvalToken,false,null,none,()->{})));
  // Intent identity: a changed route on one intent is distinct, a release frees only its own route, and
  // retention is bounded (clearing frees capacity for an explicit retry).
  NoticeTapInbox<Intent> fresh=new NoticeTapInbox<>(routes,OPEN,ASK,PREFIX);String t1="11111111-1111-4111-8111-111111111111",t2="22222222-2222-4222-8222-222222222222";
  Intent one=new Intent(OPEN,PREFIX+t1);check(t1.equals(fresh.retain(one,INTENTS)));check(fresh.retain(one,INTENTS)==null);
  one.data=PREFIX+t2;check(t2.equals(fresh.retain(one,INTENTS)));fresh.release(one,t1);check(fresh.retain(one,INTENTS)==null);
  fresh.release(one,t2);check(t2.equals(fresh.retain(one,INTENTS)));
  NoticeTapInbox<Intent> bounded=new NoticeTapInbox<>(routes,OPEN,ASK,PREFIX);Intent last=null;
  for(int i=0;i<512;i++){last=new Intent(OPEN,PREFIX+t1);check(bounded.retain(last,INTENTS)!=null);}
  Intent overflow=new Intent(OPEN,PREFIX+t1);check(bounded.retain(overflow,INTENTS)==null);
  bounded.release(last,t1);check(bounded.retain(overflow,INTENTS)!=null);
  System.out.println(checks+" assertions passed");
 }
}

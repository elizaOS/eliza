package ai.eliza.plugins.notifications;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.json.JSONObject;

/** Captures taps on the host's own notices into the durable route ledger (NoticeRoutes) and hands the
 * newest pending one to the renderer. A tap is a read request for its exact route, never a decision.
 *
 * Android-free so its ordering is testable on a JVM: the host adapts its launch Intent (action, data URI).
 * retain/release run on the UI thread; offer, drain, pending and consume run on the host's single storage
 * worker, which alone touches the retained-tap queue. An intent stays retained (and its OS notice stays
 * posted) until its capture commits, so a failed write or process death leaves an explicit retry. */
public final class NoticeTapInbox<I> {
 /** How the host reads its launch intents. */
 public interface Intents<I> {String action(I intent);String data(I intent);}
 /** A tap's capture committed (or its route is gone): the host clears that intent's data on its UI thread,
  * then calls {@link #release}. */
 public interface Captured<I> {void captured(I intent,String token);}
 /** Adds a "notice" excerpt of the still-posted own notice to a pending Ask; leaves it absent when the notice is gone. */
 public interface QuestionNotice {void attach(JSONObject pending)throws Exception;}
 /** Rechecks that the host is in the foreground and unlocked before a tap is consumed. */
 public interface Foreground {void require()throws Exception;}
 private static final int MAXIMUM_RETAINED=512;
 private final NoticeRoutes routes;private final String openAction,askAction,prefix;
 private final IdentityHashMap<I,String> retained=new IdentityHashMap<>();
 /** Storage-worker confined: token (or token + ":ask") to the intents that carried it. */
 private final LinkedHashMap<String,List<I>> uncaptured=new LinkedHashMap<>();
 public NoticeTapInbox(NoticeRoutes routes,String openAction,String askAction,String prefix){
  if(openAction==null||openAction.isBlank()||askAction==null||askAction.isBlank()||openAction.equals(askAction)||prefix==null||prefix.isBlank())throw new IllegalArgumentException("Invalid notice tap configuration");
  this.routes=Objects.requireNonNull(routes);this.openAction=openAction;this.askAction=askAction;this.prefix=prefix;
 }
 /** The route token of one of this host's notice intents, or null for any other intent. */
 public String token(I intent,Intents<I> intents){
  if(intent==null)return null;String action=intents.action(intent),data=intents.data(intent);
  if(!(openAction.equals(action)||askAction.equals(action))||data==null||!data.startsWith(prefix))return null;
  String token=data.substring(prefix.length());return token.matches("[a-f0-9-]{36}")?token:null;
 }
 /** The data URI the host's notice carries for this token; the host clears an intent only while it still has it. */
 public String data(String token){return prefix+token;}
 /** Retains a newly delivered tap intent once until its capture commits. Returns its queue key, or null when
  * the intent is not a tap, is already retained (load, resume and polling may observe the same intent) or the
  * retained bound is reached. A distinct OS intent stays a distinct tap even for the same token. */
 public synchronized String retain(I intent,Intents<I> intents){
  String token=token(intent,intents);if(token==null)return null;
  if(Objects.equals(retained.get(intent),token))return null;
  if(!retained.containsKey(intent)&&retained.size()>=MAXIMUM_RETAINED)return null;
  retained.put(intent,token);return askAction.equals(intents.action(intent))?token+":ask":token;
 }
 /** Forgets a retained intent after its capture was cleared (or its queueing was refused). */
 public synchronized void release(I intent,String token){if(Objects.equals(retained.get(intent),token))retained.remove(intent);}
 /** Storage worker: queues one retained tap and captures every retained tap. */
 public int offer(String key,I intent,Captured<I> captured){
  uncaptured.computeIfAbsent(Objects.requireNonNull(key),ignored->new ArrayList<>()).add(Objects.requireNonNull(intent));
  return drain(captured);
 }
 /** Storage worker: durably captures each retained tap. An unknown route is dropped; a tap that cannot be
  * written now stays retained for the next drain. Returns how many are still retained. */
 public int drain(Captured<I> captured){
  int failed=0;Iterator<Map.Entry<String,List<I>>> entries=uncaptured.entrySet().iterator();
  while(entries.hasNext()){
   Map.Entry<String,List<I>> entry=entries.next();String token=entry.getKey().substring(0,36);
   try{routes.capture(token,entry.getKey().endsWith(":ask"));}
   catch(NoticeRoutes.UnknownTap unknown){/* No route: nothing can open it; clear it below. */}
   catch(Exception unavailable){failed++;continue;}
   for(I intent:entry.getValue())captured.captured(intent,token);
   entries.remove();
  }
  return failed;
 }
 /** Storage worker: the newest pending tap of the current owner, or an empty object. An Ask whose own notice
  * is gone (timed out, swiped or withdrawn) has nothing left to review, so it settles into a plain open tap.
  * A capture still retained without any pending tap is reported as unavailable, never as "no tap". */
 public JSONObject pending(Captured<I> captured,QuestionNotice notices)throws Exception{
  int failed=drain(captured);JSONObject pending=routes.pending();
  if(failed>0&&!pending.has("token"))throw new IllegalStateException("Uncaptured notice tap retained");
  while(pending.optBoolean("question")){
   notices.attach(pending);if(pending.has("notice"))break;
   routes.settleQuestion(pending.getString("token"),false);pending=routes.pending();
  }
  return pending;
 }
 /** Storage worker: completes the renderer's handling of the exact pending tap. `discard` returns an
  * explicitly cancelled Ask to its untapped state. A question must name the revision of the excerpt it was
  * shown. A completed approval Ask leaves the approval waiting (its notice and tap stay usable). Returns the
  * notice ID whose OS notice the host cancels, or null when nothing is cancelled. */
 public String consume(String token,boolean discard,String noticeRevision,QuestionNotice notices,Foreground foreground)throws Exception{
  JSONObject pending=routes.pending();
  if(token==null||!token.equals(pending.optString("token")))throw new IllegalStateException("Pending tap changed");
  boolean question=pending.optBoolean("question");
  if(discard){if(!question)throw new IllegalStateException("Tap purpose changed");routes.settleQuestion(token,true);return null;}
  if(question){
   notices.attach(pending);JSONObject notice=pending.optJSONObject("notice");
   if(notice==null||!notice.getString("revision").equals(noticeRevision))throw new IllegalStateException("Question notice changed");
  }else if(noticeRevision!=null)throw new IllegalStateException("Tap purpose changed");
  foreground.require();
  String operationId=pending.getString("operationId");
  if(question&&NoticeDelivery.approvalId(operationId)){routes.releaseApprovalQuestion(token);return null;}
  routes.consume(token);return operationId;
 }
}

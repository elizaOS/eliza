import ai.eliza.plugins.notifications.MailBackgroundDelivery;
import ai.eliza.plugins.notifications.MailHistoryReconciliation;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Owner fences, durable pagination, startup continuity and unsupported deployment for the shared delivery. */
public class MailBackgroundDeliveryTest {
 static int assertions;
 static void check(boolean b,String message){assertions++;if(!b)throw new AssertionError(message);}
 interface Task {void run()throws Exception;}
 static void refuses(Task task,String message)throws Exception{try{task.run();}catch(SecurityException expected){assertions++;return;}throw new AssertionError(message);}
 static final String USER="11111111-1111-4111-8111-111111111111",ORG="22222222-2222-4222-8222-222222222222";
 static final class Host implements MailBackgroundDelivery.Host {
  final Object lock=new Object();String state,credential;boolean reset;
  public Object lock(){return lock;}
  public String readState(){return state;}public void writeState(String value){state=value;}public void removeState(){state=null;}
  public String readCredential(){return credential;}public boolean resetPending(){return reset;}
  public JSONObject verifiedIdentity(JSONObject data)throws Exception{return new JSONObject().put("userId",data.getString("id")).put("organizationId",data.getString("organization_id"));}
 }
 static final class Scheduler implements MailBackgroundDelivery.Scheduler {int schedules,cancels;String generation;public void schedule(String g){schedules++;generation=g;}public void cancel(){cancels++;generation=null;}}
 static final class Poster implements MailBackgroundDelivery.Notices {int posts;Set<String> active=new HashSet<>();public boolean allowed(){return true;}public boolean active(String k){return active.contains(k);}public void post(String k){posts++;active.add(k);}public void cancel(String k){active.remove(k);}public void cancelAll(){active.clear();}}
 static final class Transport implements MailBackgroundDelivery.Connections {
  final Host host;List<String> paths=new ArrayList<>();int historyStatus=200;boolean staleDuringHistory,wrongOwner,noGrant;Runnable onUser;Queue<JSONObject> pages=new ArrayDeque<>();
  Transport(Host host){this.host=host;}
  public HttpURLConnection open(URL url){
   check(url.getHost().equals("cloud.example"),"fixed authority");paths.add(url.getFile());
   return new HttpURLConnection(url){
    public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
    public int getResponseCode(){check("GET".equals(getRequestMethod()),"GET only");check(!getInstanceFollowRedirects(),"redirect disabled");check("Bearer secret".equals(getRequestProperty("Authorization")),"existing credential only");return url.getPath().endsWith("history")?historyStatus:200;}
    public InputStream getInputStream()throws IOException{
     try{
      JSONObject value;
      if(url.getPath().endsWith("history")){if(staleDuringHistory)host.credential=credential("replaced");value=pages.remove();}
      else if(url.getPath().endsWith("user")){if(onUser!=null)onUser.run();value=new JSONObject().put("success",true).put("data",new JSONObject().put("id",wrongOwner?"33333333-3333-4333-8333-333333333333":USER).put("organization_id",ORG));}
      else value=new JSONObject().put("success",true).put("data",new JSONArray().put(new JSONObject().put("connectionId","grant").put("connected",true).put("grantedCapabilities",new JSONArray().put(noGrant?"google.calendar.read":"google.gmail.triage"))));
      return new ByteArrayInputStream(value.toString().getBytes(StandardCharsets.UTF_8));
     }catch(Exception e){throw new IOException(e);}
    }
   };
  }
 }
 static String credential(String token)throws Exception{return new JSONObject().put("credentialId","credential").put("token",token).toString();}
 static final class Case {
  final Host host=new Host();final Scheduler scheduler=new Scheduler();final Poster poster=new Poster();final Transport transport=new Transport(host);final MailBackgroundDelivery delivery;
  Case()throws Exception{host.credential=credential("secret");delivery=new MailBackgroundDelivery(host,scheduler,poster,new MailBackgroundDelivery.Config("https://cloud.example","production","google.gmail.triage",4),transport);}
  JSONObject saved()throws Exception{return new JSONObject(host.state);}
  String configure()throws Exception{delivery.configure(delivery.begin(),"credential","grant",USER,ORG);return saved().getJSONObject("binding").getString("generation");}
 }
 public static void main(String[] args)throws Exception{
  Case a=new Case();
  check(a.delivery.status().getString("status").equals("disabled"),"unconfigured reports disabled, never a provider coupling");
  String generation=a.configure();
  check(a.saved().getJSONObject("binding").getString("accountRef").equals(new JSONArray().put("cloud").put("production").put(USER).put(ORG).toString()),"owner account reference keeps the installed format");
  check(a.scheduler.generation.equals(generation),"selection scheduled");
  a.transport.pages.add(MailHistoryReconciliationTest.baseline("100"));check(a.delivery.sync(generation,()->{}),"baseline complete job");check(a.saved().getString("historyId").equals("100"),"durable baseline");
  a.configure();check(a.saved().getString("historyId").equals("100")&&a.saved().getJSONObject("binding").getString("generation").equals(generation),"same owner reconfiguration preserves cursor");
  long attempt=a.delivery.begin();a.delivery.resume();check(a.saved().getString("historyId").equals("100"),"resume during configure preserves cursor");a.delivery.configure(attempt,"credential","grant",USER,ORG);
  a.transport.pages.add(MailHistoryReconciliationTest.page("100","110","opaque token",MailHistoryReconciliationTest.event("101","message-added","mail","INBOX","UNREAD")));a.transport.pages.add(MailHistoryReconciliationTest.page("100","112",null));
  check(a.delivery.sync(generation,()->{}),"paged sync");check(a.transport.paths.stream().anyMatch(p->p.contains("startHistoryId=100&pageToken=opaque+token")),"original checkpoint and encoded continuation");
  check(a.saved().getString("historyId").equals("112")&&a.poster.posts==1,"one native notice and final checkpoint");
  String notice=a.saved().getJSONObject("notices").keys().next();a.delivery.capture(notice,false);boolean[] unlocked={true};a.transport.onUser=()->unlocked[0]=false;
  refuses(()->a.delivery.pending(()->{if(!unlocked[0])throw new SecurityException("locked");}),"locked response admitted");
  check(a.saved().has("tap"),"lock during grant check retains tap");String token=a.saved().getJSONObject("tap").getString("token");
  refuses(()->a.delivery.consume(token,()->{throw new SecurityException("paused");}),"paused consume admitted");check(a.saved().has("tap"),"pause cannot consume unseen tap");
  a.transport.onUser=null;unlocked[0]=true;JSONObject tap=a.delivery.pending(()->{});check(tap.getString("userId").equals(USER)&&tap.getString("grantId").equals("grant"),"verified tap names owner and grant");a.delivery.consume(tap.getString("token"),()->{});check(!a.saved().has("tap")&&a.poster.active.isEmpty(),"tap consumed once and notice withdrawn");
  a.transport.historyStatus=404;check(a.delivery.sync(generation,()->{}),"unsupported is not a retry storm");check(a.delivery.status().getString("status").equals("unsupported"),"undeployed endpoint truthful");
  a.transport.historyStatus=503;check(!a.delivery.sync(generation,()->{}),"server failure retries");check(a.delivery.status().getString("status").equals("retrying"),"retry state reported");
  a.transport.historyStatus=200;a.transport.staleDuringHistory=true;a.transport.pages.add(MailHistoryReconciliationTest.page("112","114",null,MailHistoryReconciliationTest.event("113","message-added","stale","INBOX","UNREAD")));
  refuses(()->a.delivery.sync(generation,()->{}),"stale read admitted");check(new JSONObject(a.host.state).getString("historyId").equals("112")&&a.poster.posts==1,"credential changed during I/O cannot publish or advance");
  a.delivery.withdraw(null);check(a.host.state==null&&a.poster.active.isEmpty()&&a.scheduler.generation==null,"withdraw removes cursor, schedule and notices");
  refuses(()->a.delivery.sync(generation,()->{}),"withdrawn job runs");

  Case wrong=new Case();wrong.transport.wrongOwner=true;refuses(wrong::configure,"remote owner mismatch admitted");check(wrong.host.state==null,"remote owner cannot configure");
  Case grant=new Case();grant.transport.noGrant=true;refuses(grant::configure,"missing read grant admitted");check(grant.host.state==null,"grant without the read capability cannot configure");
  Case other=new Case();refuses(()->other.delivery.configure(other.delivery.begin(),"other-credential","grant",USER,ORG),"other credential admitted");refuses(()->other.delivery.configure(other.delivery.begin(),"credential","grant",USER,""),"missing organization admitted");
  Case reset=new Case();reset.host.reset=true;refuses(reset::configure,"pending reset admitted");check(reset.host.state==null,"reset blocks configuration");
  Case superseded=new Case();long first=superseded.delivery.begin();superseded.delivery.begin();refuses(()->superseded.delivery.configure(first,"credential","grant",USER,ORG),"superseded selection admitted");check(superseded.host.state==null,"superseded selection saves nothing");
  Case changed=new Case();String old=changed.configure();changed.host.credential=credential("rotated");refuses(()->changed.delivery.sync(old,()->{}),"rotated credential admitted");changed.delivery.resume();check(changed.host.state==null,"resume retires a selection whose credential changed");
  Case other2=new Case();other2.configure();other2.delivery.withdraw("another-grant");check(other2.host.state!=null,"withdraw for another grant keeps the selection");
  System.out.println(assertions+" assertions passed");
 }
}

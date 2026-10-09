package ai.eliza.plugins.agent.health.contract;
import ai.eliza.plugins.agent.health.LocalRuntimeHealth;
import java.io.IOException;
import java.util.concurrent.atomic.*;
import org.json.JSONObject;
/** Controlled local protocol and lifecycle cases; no real runtime or credentials. */
public final class LocalRuntimeHealthContract {
 private static void check(boolean ok){if(!ok)throw new AssertionError();}
 private static final Object OWNER=new Object(),AGENT=new Object(),GATEWAY=new Object();
 private static LocalRuntimeHealth.Snapshot snapshot(String instance,String state,long epoch,boolean stopping,boolean alive){return new LocalRuntimeHealth.Snapshot(OWNER,instance,state,epoch,stopping,AGENT,()->alive,GATEWAY,()->alive);}
 public static void run()throws Exception{
  AtomicReference<LocalRuntimeHealth.Snapshot> state=new AtomicReference<>();AtomicInteger calls=new AtomicInteger();AtomicInteger schema=new AtomicInteger(1);AtomicBoolean fail=new AtomicBoolean(),change=new AtomicBoolean();AtomicReference<String> storage=new AtomicReference<>("ok");
  LocalRuntimeHealth observer=new LocalRuntimeHealth("process",state::get,(snapshot,gateway,route,budget)->{
   check(budget==321);calls.incrementAndGet();if(fail.get())throw new IOException("transport unavailable");
   if(change.get())state.set(snapshot("replacement","running",2,false,true));
   if(!gateway){check(route.equals("/api/status"));return new JSONObject().put("status",200);}
   check(route.equals("/local-health")||route.equals("/local-storage"));
   return new JSONObject().put("status",200).put("data",new JSONObject().put("schemaVersion",schema.get()).put("gatewayResponsive",true).put("ownershipLoaded",true).put("taskStorage",storage.get()));
  },321);
  JSONObject absent=observer.read();check(calls.get()==0&&observer.unchanged(absent)&&absent.getString("runtimeInstance").equals("none"));
  state.set(snapshot("one","stopped",1,false,true));check(!observer.read().getBoolean("agentResponsive")&&calls.get()==0&&!observer.unchanged(absent));
  state.set(snapshot("one","running",1,true,true));check(!observer.read().getBoolean("gatewayResponsive")&&calls.get()==0);
  state.set(snapshot("one","running",1,false,true));JSONObject healthy=observer.read();check(calls.get()==3&&healthy.getBoolean("agentResponsive")&&healthy.getBoolean("gatewayResponsive")&&healthy.getString("taskStorage").equals("ok")&&observer.unchanged(healthy));
  storage.set("deferred");check(observer.read().getString("taskStorage").equals("deferred"));storage.set("invented");check(observer.read().getString("taskStorage").equals("unavailable"));
  schema.set(2);int before=calls.get();JSONObject invalid=observer.read();check(!invalid.getBoolean("gatewayResponsive")&&calls.get()==before+2&&invalid.getString("taskStorage").equals("unavailable"));schema.set(1);
  fail.set(true);JSONObject failed=observer.read();check(!failed.getBoolean("agentResponsive")&&!failed.getBoolean("gatewayResponsive"));fail.set(false);
  change.set(true);try{observer.read();throw new AssertionError("Stale runtime accepted");}catch(IOException expected){}change.set(false);check(!observer.unchanged(healthy));
  state.set(snapshot("one","running",1,false,false));before=calls.get();check(!observer.read().getBoolean("agentResponsive")&&calls.get()==before&&!observer.unchanged(healthy));
  healthy.put("processInstance","other");check(!observer.unchanged(healthy));
  // A gateway can exit after answering storage but before the final liveness read.
  for(String observed:new String[]{"ok","deferred"}){
   AtomicBoolean live=new AtomicBoolean(true);
   LocalRuntimeHealth.Snapshot crashing=new LocalRuntimeHealth.Snapshot(OWNER,"crash","running",1,false,AGENT,()->true,GATEWAY,live::get);
   LocalRuntimeHealth crashObserver=new LocalRuntimeHealth("process",()->crashing,(snapshot,gateway,route,budget)->{
    if(!gateway)return new JSONObject().put("status",200);
    if(route.equals("/local-storage"))live.set(false);
    return new JSONObject().put("status",200).put("data",new JSONObject().put("schemaVersion",1).put("gatewayResponsive",true).put("ownershipLoaded",true).put("taskStorage",observed));
   },321);
   JSONObject crashed=crashObserver.read();check(!crashed.getBoolean("gatewayResponsive")&&crashed.getString("taskStorage").equals("unavailable"));
  }
 }
}

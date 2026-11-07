package ai.eliza.plugins.agent.health;

import java.io.IOException;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.json.JSONObject;

/** Read-only local runtime observations. Never starts processes or admits an update. */
public final class LocalRuntimeHealth {
  public static final class Snapshot {
    public final Object owner, agent, gateway;
    public final String instance, state;
    public final long epoch;
    public final boolean stopping;
    private final BooleanSupplier agentAlive, gatewayAlive;
    public Snapshot(Object owner, String instance, String state, long epoch, boolean stopping,
        Object agent, BooleanSupplier agentAlive, Object gateway, BooleanSupplier gatewayAlive) {
      this.owner=owner; this.instance=Objects.requireNonNull(instance); this.state=Objects.requireNonNull(state);
      this.epoch=epoch; this.stopping=stopping; this.agent=agent; this.gateway=gateway;
      this.agentAlive=Objects.requireNonNull(agentAlive); this.gatewayAlive=Objects.requireNonNull(gatewayAlive);
    }
    public boolean agentAlive(){return agent!=null&&agentAlive.getAsBoolean();}
    public boolean gatewayAlive(){return gateway!=null&&gatewayAlive.getAsBoolean();}
  }
  public interface Probe {
    JSONObject exchange(Snapshot snapshot, boolean gateway, String route, int timeoutMillis)throws Exception;
  }
  private final String processInstance;
  private final Supplier<Snapshot> snapshots;
  private final Probe probe;
  private final int timeoutMillis;
  public LocalRuntimeHealth(String processInstance,Supplier<Snapshot> snapshots,Probe probe,int timeoutMillis) {
    if(processInstance==null||processInstance.isEmpty()||timeoutMillis<=0)throw new IllegalArgumentException("Process identity and positive probe budget required");
    this.processInstance=processInstance;this.snapshots=Objects.requireNonNull(snapshots);this.probe=Objects.requireNonNull(probe);this.timeoutMillis=timeoutMillis;
  }
  public JSONObject read()throws Exception {
    Snapshot before=snapshots.get();
    if(before==null)return evidence("none","stopped",0,"unavailable",false,false);
    boolean agentReady=false,gatewayReady=false;String storage="unavailable";
    if("running".equals(before.state)&&!before.stopping){
      if(before.agentAlive())try{agentReady=probe.exchange(before,false,"/api/status",timeoutMillis).getInt("status")==200;}catch(IOException ignored){}
      if(before.gatewayAlive())try{
        JSONObject response=probe.exchange(before,true,"/local-health",timeoutMillis),data=response.getJSONObject("data");
        gatewayReady=response.getInt("status")==200&&data.optInt("schemaVersion")==1&&data.optBoolean("gatewayResponsive")&&data.optBoolean("ownershipLoaded");
      }catch(IOException ignored){}
    }
    if(gatewayReady)try{
      JSONObject response=probe.exchange(before,true,"/local-storage",timeoutMillis),data=response.getJSONObject("data");String observed=data.optString("taskStorage");
      if(response.getInt("status")==200&&data.optInt("schemaVersion")==1&&java.util.Arrays.asList("ok","unavailable","deferred").contains(observed))storage=observed;
    }catch(IOException ignored){}
    Snapshot after=snapshots.get();
    if(after==null||before.owner!=after.owner||!before.instance.equals(after.instance)||before.epoch!=after.epoch||!before.state.equals(after.state)||before.stopping!=after.stopping||before.agent!=after.agent||before.gateway!=after.gateway)throw new IOException("Runtime changed during health observation");
    boolean gatewayResponsive=gatewayReady&&before.gatewayAlive();
    if(!gatewayResponsive)storage="unavailable";
    return evidence(before.instance,before.state,before.epoch,storage,agentReady&&before.agentAlive(),gatewayResponsive);
  }
  public boolean unchanged(JSONObject observation)throws Exception {
    if(!processInstance.equals(observation.getString("processInstance")))return false;
    Snapshot current=snapshots.get();
    if(current==null)return "none".equals(observation.getString("runtimeInstance"));
    return current.instance.equals(observation.getString("runtimeInstance"))&&current.epoch==observation.getLong("runtimeEpoch")&&current.state.equals(observation.getString("runtimeState"))
      &&(!observation.getBoolean("agentResponsive")||(!current.stopping&&current.agentAlive()))
      &&(!observation.getBoolean("gatewayResponsive")||(!current.stopping&&current.gatewayAlive()));
  }
  private JSONObject evidence(String instance,String state,long epoch,String storage,boolean agent,boolean gateway)throws Exception {
    return new JSONObject().put("processInstance",processInstance).put("runtimeInstance",instance).put("runtimeState",state).put("runtimeEpoch",epoch).put("taskStorage",storage).put("agentResponsive",agent).put("gatewayResponsive",gateway);
  }
}

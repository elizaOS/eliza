package ai.eliza.plugins.agent;
import ai.eliza.plugins.agent.health.NativeHealthService;
import ai.eliza.plugins.agent.health.contract.NativeHealthServiceContract;
import android.content.ComponentName;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
@RunWith(AndroidJUnit4.class)
public final class NativeHealthServiceInstrumentedTest {
 /** Supervised by this test package, so the contract must fail against it. */
 public static class SelfSupervised extends NativeHealthService {
  @Override protected String supervisorPackage(){return getPackageName();}
  @Override protected long requestBudgetMillis(){return 1;}
  @Override protected long uiBudgetMillis(){return 1;}
  @Override protected long versionCode(){return -1;}
  @Override protected String distribution(){return "standalone";}
  @Override protected JSONObject runtimeObservation(){throw new UnsupportedOperationException();}
  @Override protected void checkStorage(long deadline){throw new UnsupportedOperationException();}
  @Override protected JSONObject uiObservation(long deadline){throw new UnsupportedOperationException();}
  @Override protected boolean runtimeUnchanged(JSONObject observation){throw new UnsupportedOperationException();}
 }
 public static final class OtherSupervisor extends SelfSupervised {
  @Override protected String supervisorPackage(){return "invalid.example.supervisor";}
 }
 @Test public void sameSignerCallerIsRefusedUnlessItIsTheSupervisor()throws Exception {
  Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
  NativeHealthServiceContract.assertRefusesSameSigner(context,new ComponentName(context,OtherSupervisor.class));
  try{NativeHealthServiceContract.assertRefusesSameSigner(context,new ComponentName(context,SelfSupervised.class));throw new IllegalStateException("Supervisor caller was refused");}
  catch(AssertionError expected){if(!String.valueOf(expected.getMessage()).contains("not refused: 400"))throw expected;}
 }
}

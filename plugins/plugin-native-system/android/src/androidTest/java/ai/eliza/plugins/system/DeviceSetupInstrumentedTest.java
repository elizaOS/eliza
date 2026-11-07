package ai.eliza.plugins.system;

import ai.eliza.plugins.system.setup.DeviceSetup;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real package/settings observations; navigation is captured without launching or changing defaults. */
@RunWith(AndroidJUnit4.class)
public final class DeviceSetupInstrumentedTest {
 @Test public void independentHostPolicyAndNavigation()throws Exception {
  Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();String own=app.getPackageName();
  Set<String> browsers=new LinkedHashSet<>(Arrays.asList(own)), providers=new LinkedHashSet<>(Arrays.asList(own));
  List<Intent> intents=new ArrayList<>();int[] trustCalls={0};
  DeviceSetup setup=new DeviceSetup(app,browsers,providers,own,"",(name,certificate)->{trustCalls[0]++;return false;},intents::add);
  browsers.clear();providers.clear(); // caller mutation must not change admitted packages
  JSONObject status=setup.readiness();
  assertEquals(own,status.getJSONArray("installedBrowsers").getString(0));
  assertEquals(own,status.getJSONArray("installedPasswordManagers").getString(0));
  assertEquals("not-configured",status.getString("browserDispatchStatus"));assertEquals(0,trustCalls[0]);
  assertFalse(status.getBoolean("browserObservationAvailable"));assertFalse(status.getBoolean("providerVaultReadinessKnown"));assertFalse(status.getBoolean("canChangeDefaultsSilently"));
  assertEquals(DeviceSetup.Outcome.UNSUPPORTED_BROWSER,setup.open(DeviceSetup.Target.BROWSER_APP,"unlisted.example"));
  assertEquals(DeviceSetup.Outcome.UNSUPPORTED_PASSWORD_MANAGER,setup.open(DeviceSetup.Target.PASSWORD_MANAGER_APP,"unlisted.example"));
  assertEquals(DeviceSetup.Outcome.UNSUPPORTED_PACKAGE,setup.open(DeviceSetup.Target.APP_DETAILS,"unlisted.example"));assertTrue(intents.isEmpty());
  assertEquals(DeviceSetup.Outcome.OPENED,setup.open(DeviceSetup.Target.APP_DETAILS,own));
  Intent details=intents.remove(0);assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,details.getAction());assertEquals("package:"+own,details.getDataString());assertTrue((details.getFlags()&Intent.FLAG_ACTIVITY_NEW_TASK)!=0);
  assertEquals(DeviceSetup.Outcome.OPENED,setup.open(DeviceSetup.Target.BROWSER_DEFAULTS,null));assertEquals(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS,intents.remove(0).getAction());
  DeviceSetup rejected=new DeviceSetup(app,Collections.singleton(own),Collections.emptySet(),own,"synthetic-pin",(name,certificate)->{assertEquals(own,name);assertEquals("synthetic-pin",certificate);return false;},intent->{throw new IllegalStateException("Unavailable activity");});
  assertEquals("untrusted",rejected.readiness().getString("browserDispatchStatus"));assertEquals(DeviceSetup.Outcome.UNAVAILABLE,rejected.open(DeviceSetup.Target.CREDENTIAL_PROVIDERS,null));
  DeviceSetup missing=new DeviceSetup(app,Collections.emptySet(),Collections.emptySet(),"example.nonexistent."+UUID.randomUUID().toString().replace("-",""),"synthetic-pin",(name,certificate)->{throw new AssertionError("Trust check preceded installation check");},intents::add);
  assertEquals("not-installed",missing.readiness().getString("browserDispatchStatus"));
 }
}

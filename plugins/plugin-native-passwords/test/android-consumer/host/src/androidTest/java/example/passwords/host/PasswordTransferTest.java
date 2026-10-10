package example.passwords.host;

import ai.eliza.plugins.passwords.PasswordVaultAccess;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.UiAutomation;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real Capacitor -> SAF document picker -> device authentication -> encrypted vault.
 * The runner owns a fresh emulator user, removed with every synthetic file afterwards. */
public final class PasswordTransferTest {
 private final PasswordConsumerTest ui = new PasswordConsumerTest();
 private ActivityScenario<TransferActivity> scenario;
 private String js(String source) {
  CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
  scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(source, value -> { result.set(value); done.countDown(); }));
  try { assertTrue("Fixture JavaScript completes", done.await(10, TimeUnit.SECONDS)); }
  catch (InterruptedException interrupted) { throw new AssertionError(interrupted); }
  return result.get();
 }
 private void invoke(String key, String plugin, String method, JSONObject args) {
  js("invoke(" + JSONObject.quote(key) + "," + JSONObject.quote(plugin) + "," + JSONObject.quote(method) + "," + args + ")");
 }
 private void value(String key, String predicate) {
  ui.await(() -> "true".equals(js("Boolean(results[" + JSONObject.quote(key) + "]?.value && (" + predicate + "))")), "Bridge result: " + key);
 }
 private void unlock(String pin) throws Exception {
  invoke("unlock", "ElizaPasswords", "unlock", new JSONObject()); ui.pin(pin); value("unlock", "results.unlock.value.unlocked===true");
 }
 @Test public void transferUsesRealPickerFreshUnlockAndCountsOnly() throws Exception {
  assertEquals("1", InstrumentationRegistry.getArguments().getString("disposablePasswordFixture"));
  assertTrue(ui.shell("getprop ro.hardware").matches("ranchu|goldfish|cutf_cvm"));
  String user = ui.shell("am get-current-user"); assertTrue(user.matches("[0-9]+")); assertNotEquals("0", user);
  Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
  KeyguardManager keyguard = context.getSystemService(KeyguardManager.class); assertFalse(keyguard.isDeviceSecure());
  UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
  AccessibilityServiceInfo info = automation.getServiceInfo(); info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS; automation.setServiceInfo(info);
  String pin = "7" + (100000 + new java.security.SecureRandom().nextInt(800000));
  String token = UUID.randomUUID().toString().substring(0, 8), password = "Synthetic-transfer-" + token;
  boolean ownPin = false;
  try {
   ui.shell("locksettings set-pin --user " + user + " " + pin); ownPin = true;
   ui.await(keyguard::isDeviceSecure, "Synthetic screen lock ready");
   scenario = ActivityScenario.launch(TransferActivity.class);
   ui.await(() -> "true".equals(js("Boolean(window.Capacitor?.nativePromise && window.invoke)")), "Real Capacitor bridge ready");
   unlock(pin);
   invoke("save", "ElizaPasswords", "save", new JSONObject().put("label", "Synthetic transfer").put("username", "synthetic-" + token)
     .put("websites", new org.json.JSONArray().put("https://transfer.example")).put("password", password));
   value("save", "true");
   String id = new org.json.JSONTokener(js("results.save.value.id")).nextValue().toString();

   invoke("export", "ElizaPasswordTransfer", "exportVault", new JSONObject());
   ui.await(() -> ui.find(node -> "Export saved passwords?".contentEquals(node.getText() == null ? "" : node.getText())) != null, "Export review shown");
   ui.captureDialog("This exports all saved passwords", "password-export-review.png");
   invoke("overlap", "ElizaPasswordTransfer", "importVault", new JSONObject());
   ui.await(() -> "true".equals(js("results.overlap?.error==='busy'")), "Overlapping transfer is refused");
   ui.press("Cancel");
   ui.await(() -> "true".equals(js("results.export?.error==='cancelled'")), "Cancelled export settles its call");

   invoke("export", "ElizaPasswordTransfer", "exportVault", new JSONObject()); ui.press("Export");
   ui.press("Save"); ui.pin(pin);
   value("export", "results.export.value.exported===1 && Object.keys(results.export.value).length===1");
   assertFalse("Completed export locks its own grant", PasswordVaultAccess.get(context).unlocked());

   unlock(pin);
   invoke("delete", "ElizaPasswords", "remove", new JSONObject().put("id", id)); value("delete", "true");
   invoke("import", "ElizaPasswordTransfer", "importVault", new JSONObject());
   ui.press("passwords.csv"); ui.pin(pin);
   ui.await(() -> ui.find(node -> String.valueOf(node.getText()).contains("https://transfer.example")) != null, "Exact imported origin is reviewed");
   ui.captureDialog("https://transfer.example", "password-import-review.png");
   ui.press("Import"); value("import", "results.import.value.imported===1 && results.import.value.skipped===0 && Object.keys(results.import.value).length===2");
   unlock(pin);
   PasswordVaultAccess access = PasswordVaultAccess.get(context);
   assertTrue("Reimported secret is exact", access.use(access.ticket(), store -> {
    org.json.JSONArray entries = store.entries();
    return entries.length() == 1 && password.equals(store.get(entries.getJSONObject(0).getString("id")).getString("password"));
   }));
   invoke("stopped", "ElizaPasswordTransfer", "exportVault", new JSONObject());
   ui.await(() -> ui.find(node -> "Export saved passwords?".contentEquals(node.getText() == null ? "" : node.getText())) != null, "Review owns the foreground Activity");
   scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
   scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
   ui.await(() -> "true".equals(js("results.stopped?.error==='cancelled'")), "Backgrounded review settles cancellation");
   assertFalse("Backgrounding revokes the grant", access.unlocked());

   invoke("destroyed", "ElizaPasswordTransfer", "importVault", new JSONObject());
   ui.press("passwords.csv");
   ui.await(access::pending, "Returned picker requires a fresh challenge");
   InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
    for (androidx.test.runner.lifecycle.Stage stage : androidx.test.runner.lifecycle.Stage.values())
     for (android.app.Activity activity : androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage))
      if (activity instanceof TransferActivity && !activity.isFinishing()) activity.finish();
   });
   ui.await(() -> !access.pending() && !access.unlocked(), "Destroyed transfer owner cancels its authentication");
  } finally {
   if (scenario != null) scenario.close();
   if (ownPin) { PasswordConsumerTest.clearSyntheticVault(context); ui.shell("locksettings clear --user " + user + " --old " + pin); }
  }
 }
}

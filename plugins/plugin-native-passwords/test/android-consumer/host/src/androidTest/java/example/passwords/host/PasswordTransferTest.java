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
 private void editorField(String label, String text) {
  android.os.Bundle args = new android.os.Bundle();
  args.putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
  ui.await(() -> {
   android.view.accessibility.AccessibilityNodeInfo node = ui.find(item -> item.isEditable() && label.contentEquals(item.getContentDescription() == null ? "" : item.getContentDescription()));
   return node != null && node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, args);
  }, "Native editor accepts " + label);
 }
 private void obscuredSave(int flags) {
  InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
   android.widget.Button save = null;
   for (android.view.View root : android.view.inspector.WindowInspector.getGlobalWindowViews()) {
    android.widget.Button button = root.findViewById(android.R.id.button1);
    if (button != null && button.isShown() && "Save".contentEquals(button.getText())) save = button;
   }
   assertNotNull("Native Save action exists", save);
   android.view.MotionEvent.PointerProperties pointer = new android.view.MotionEvent.PointerProperties(); pointer.id = 0; pointer.toolType = android.view.MotionEvent.TOOL_TYPE_FINGER;
   android.view.MotionEvent.PointerCoords coords = new android.view.MotionEvent.PointerCoords(); coords.x = save.getWidth()/2f; coords.y = save.getHeight()/2f; coords.pressure = 1;
   long now = android.os.SystemClock.uptimeMillis();
   for (int action : new int[]{android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP}) {
    android.view.MotionEvent event = android.view.MotionEvent.obtain(now, now, action, 1,
      new android.view.MotionEvent.PointerProperties[]{pointer}, new android.view.MotionEvent.PointerCoords[]{coords},
      0, 0, 1, 1, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, flags);
    try { save.dispatchTouchEvent(event); } finally { event.recycle(); }
   }
  });
 }
 private void unlock(String pin) throws Exception {
  invoke("unlock", "ElizaPasswords", "unlock", new JSONObject()); ui.pin(pin); value("unlock", "results.unlock.value.unlocked===true");
 }
 private void pressKeyguardControl(String id) {
  ui.await(() -> {
   android.view.accessibility.AccessibilityNodeInfo node = ui.find(item ->
     ("com.android.systemui:id/" + id).equals(item.getViewIdResourceName()));
   return node != null && node.isEnabled() && node.isClickable();
  }, "OS lock-screen control is ready: " + id);
  android.view.accessibility.AccessibilityNodeInfo node = ui.find(item ->
    ("com.android.systemui:id/" + id).equals(item.getViewIdResourceName()));
  assertNotNull("OS lock-screen control remains available: " + id, node);
  assertTrue("OS lock-screen control accepts one input: " + id,
    node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK));
 }
 @Test public void transferUsesRealPickerFreshUnlockAndCountsOnly() throws Exception {
  assertEquals("1", InstrumentationRegistry.getArguments().getString("disposablePasswordFixture"));
  assertTrue(ui.shell("getprop ro.hardware").matches("ranchu|goldfish|cutf_cvm"));
  String user = ui.shell("am get-current-user"); assertTrue(user.matches("[0-9]+")); assertNotEquals("0", user);
  Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
  KeyguardManager keyguard = context.getSystemService(KeyguardManager.class); assertFalse(keyguard.isDeviceSecure());
  UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
  AccessibilityServiceInfo info = automation.getServiceInfo(); info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS; automation.setServiceInfo(info);
  String pin = "7" + (100000 + new java.security.SecureRandom().nextInt(800000));
  String token = UUID.randomUUID().toString().substring(0, 8), password = "Synthetic-transfer-" + token;
  java.io.File migratedDirectory = new java.io.File(context.getNoBackupFilesDir(), "migration-" + token);
  String migratedAlias = "example.passwords.migration." + token;
  java.io.File unrelatedDirectory = new java.io.File(context.getNoBackupFilesDir(), "unrelated-" + token);
  String unrelatedAlias = migratedAlias + ".unrelated";
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

   // The source retains its authentication-bound key and byte-for-byte frame.
   ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore migrated = new ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore(
     migratedDirectory, migratedAlias, ("migration-v1-" + token).getBytes(java.nio.charset.StandardCharsets.UTF_8),
     ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore.KeyPolicy.deviceUnlocked(context));
   PasswordVaultAccess original = PasswordVaultAccess.get(context);
   java.io.File originalFrame = new java.io.File(original.config.directory, "vault.enc");
   byte[] originalBytes = java.nio.file.Files.readAllBytes(originalFrame.toPath());
   assertEquals(1, (int) original.use(store -> store.migrateToDeviceUnlocked(migrated)));
   assertEquals("Interrupted host selection can retry the same snapshot", 1, (int) original.use(store -> store.migrateToDeviceUnlocked(migrated)));
   assertArrayEquals(originalBytes, java.nio.file.Files.readAllBytes(originalFrame.toPath()));
   assertFalse("New key has no app authentication window", migrated.keyProtection().isUserAuthenticationRequired());
   assertEquals(password, migrated.get(id).getString("password"));
   assertEquals(id, migrated.entries().getJSONObject(0).getString("id"));
   java.io.File markerFile = new java.io.File(migratedDirectory, "vault.device-unlocked-v1");
   byte[] markerBytes = java.nio.file.Files.readAllBytes(markerFile.toPath());
   java.nio.file.Files.delete(markerFile.toPath());
   try { migrated.keyProtection(); fail("A pre-existing key without provenance was admitted"); }
   catch (java.io.IOException expected) {}
   java.nio.file.Files.write(markerFile.toPath(), markerBytes);
   byte[] corruptMarker = markerBytes.clone(); corruptMarker[corruptMarker.length - 1] ^= 1;
   java.nio.file.Files.write(markerFile.toPath(), corruptMarker);
   try { migrated.keyProtection(); fail("Corrupt provenance was admitted"); }
   catch (java.security.GeneralSecurityException expected) {}
   java.nio.file.Files.write(markerFile.toPath(), markerBytes);
   javax.crypto.KeyGenerator unrelatedGenerator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
   unrelatedGenerator.init(new android.security.keystore.KeyGenParameterSpec.Builder(unrelatedAlias,
     android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
     .setKeySize(256).setBlockModes("GCM").setEncryptionPaddings("NoPadding").build());
   unrelatedGenerator.generateKey(); // Intentionally lacks unlockedDeviceRequired.
   ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore unrelated = new ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore(
     unrelatedDirectory, unrelatedAlias, ("migration-v1-" + token).getBytes(java.nio.charset.StandardCharsets.UTF_8),
     ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore.KeyPolicy.deviceUnlocked(context));
   try { unrelated.keyProtection(); fail("An unrelated non-authentication key was admitted"); }
   catch (java.io.IOException expected) {}
   java.nio.file.Files.write(new java.io.File(unrelatedDirectory, "vault.device-unlocked-v1").toPath(), markerBytes);
   try { unrelated.keyProtection(); fail("Copied key provenance was admitted"); }
   catch (java.security.GeneralSecurityException expected) {}

   original.lock();
   assertEquals("App grant expiry does not lock device-only custody", password, migrated.get(id).getString("password"));
   unlock(pin);
   migrated.saveEntry(null, "Target-only fixture", "fixture", java.util.Collections.singletonList("https://target.example"), "Synthetic-target");
   try { original.use(store -> store.migrateToDeviceUnlocked(migrated)); fail("Different target snapshot was replaced"); }
   catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("different records")); }
   assertEquals(2, migrated.entries().length());
   assertArrayEquals(originalBytes, java.nio.file.Files.readAllBytes(originalFrame.toPath()));

   // A real native editor creates a second encrypted entry without carrying its
   // draft through Capacitor. Only the saved id returns to the WebView.
   invoke("editor", "ElizaPasswords", "openEditor", new JSONObject());
   ui.await(() -> ui.find(node -> "Add a password".contentEquals(node.getText() == null ? "" : node.getText())) != null, "Native password editor shown");
   String editorPassword = "Native-only-" + token + "x".repeat(4100);
   editorField("Name", "Editor fixture");
   editorField("HTTPS website origin", "https://editor.example");
   editorField("Username", "editor-" + token);
   editorField("Password", editorPassword);
   ui.captureDialog("Add a password", "password-editor-filled.png");
   for (int flag : new int[]{android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED, android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED}) {
    obscuredSave(flag);
    assertEquals("Obscured Save has no vault effect", 1, (int) PasswordVaultAccess.get(context).use(store -> store.entries().length()));
    assertEquals("Obscured Save does not resolve the bridge", "true", js("results.editor.pending===true"));
   }
   ui.press("Save");
   value("editor", "results.editor.value.status==='saved' && Object.keys(results.editor.value).length===2");
   String editorId = new org.json.JSONTokener(js("results.editor.value.id")).nextValue().toString();
   assertFalse("Secret never returned through bridge", js("JSON.stringify(results)").contains(editorPassword));
   assertTrue("Native entry bytes are exact", PasswordVaultAccess.get(context).use(store ->
     editorPassword.equals(store.get(editorId).getString("password"))));
   invoke("editorDelete", "ElizaPasswords", "remove", new JSONObject().put("id", editorId)); value("editorDelete", "true");
   invoke("cancelEditor", "ElizaPasswords", "openEditor", new JSONObject());
   ui.press("Cancel"); value("cancelEditor", "results.cancelEditor.value.status==='cancelled' && Object.keys(results.cancelEditor.value).length===1");

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
   ui.shell("settings --user " + user + " put secure lock_screen_lock_after_timeout 0");
   ui.shell("settings --user " + user + " put secure lockscreen.power_button_instantly_locks 1");
   ui.shell("input keyevent KEYCODE_SLEEP");
   ui.await(keyguard::isDeviceLocked, "Real OS device lock is active");
   try { migrated.entries(); fail("Locked device allowed vault access"); }
   catch (ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore.DeviceLocked expected) {}
   java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
   try {
    javax.crypto.Cipher operation = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
    operation.init(javax.crypto.Cipher.ENCRYPT_MODE, keys.getKey(migratedAlias, null)); operation.doFinal(new byte[]{1});
    fail("OS Keystore admitted the device-unlocked key while locked");
   } catch (java.security.GeneralSecurityException expected) {}
   ui.shell("input keyevent KEYCODE_WAKEUP");
   ui.shell("wm dismiss-keyguard");
   // The OS bouncer is asynchronous. Do not type into a credential field
   // belonging to an underlying Activity while the lock screen is animating.
   ui.await(() -> ui.find(node -> node.isPassword() && node.isEditable() && node.isFocused()
     && "com.android.systemui".contentEquals(node.getPackageName() == null ? "" : node.getPackageName())) != null,
     "OS lock-screen PIN field owns input focus");
   // Drive the actual keyguard keypad; shell text injection can race the
   // bouncer transition and send keys to the Activity behind the lock screen.
   for (char digit : pin.toCharArray()) pressKeyguardControl("key" + digit);
   pressKeyguardControl("key_enter");
   ui.await(() -> !keyguard.isDeviceLocked(), "OS device unlock restores access");
   assertEquals("Device unlock needs no app grant", password, migrated.get(id).getString("password"));
  } finally {
   if (scenario != null) scenario.close();
   java.security.KeyStore migrationKeys = java.security.KeyStore.getInstance("AndroidKeyStore"); migrationKeys.load(null);
   for (String alias : new String[]{migratedAlias, unrelatedAlias}) if (migrationKeys.containsAlias(alias)) migrationKeys.deleteEntry(alias);
   for (java.io.File directory : new java.io.File[]{migratedDirectory, unrelatedDirectory}) {
    for (String file : new String[]{"vault.enc", "vault.enc.bak", "vault.enc.new", "vault.device-unlocked-v1", "vault.device-unlocked-v1.bak", "vault.device-unlocked-v1.new"}) {
     java.io.File owned = new java.io.File(directory, file); assertTrue(!owned.exists() || owned.delete());
    }
    assertTrue(!directory.exists() || directory.delete());
   }
   if (ownPin) { PasswordConsumerTest.clearSyntheticVault(context); ui.shell("locksettings clear --user " + user + " --old " + pin); }
  }
 }
}

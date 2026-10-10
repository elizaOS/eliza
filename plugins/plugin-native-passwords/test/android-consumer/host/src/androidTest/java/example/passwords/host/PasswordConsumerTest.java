package example.passwords.host;

import ai.eliza.plugins.passwords.PasswordVaultAccess;
import ai.eliza.plugins.passwords.PasswordFillActivity;
import ai.eliza.plugins.passwords.PasswordSaveActivity;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real offline app -> framework Save -> credential prompt -> provider picker -> framework fill. */
public final class PasswordConsumerTest {
 private final UiAutomation ui = InstrumentationRegistry.getInstrumentation().getUiAutomation();
 private String shell(String command) throws Exception {
  try (ParcelFileDescriptor fd = ui.executeShellCommand(command); java.io.InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(fd)) { return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim(); }
 }
 private AccessibilityNodeInfo find(Predicate<AccessibilityNodeInfo> match) {
  List<AccessibilityNodeInfo> roots = new ArrayList<>();
  for (AccessibilityWindowInfo window : ui.getWindows()) { AccessibilityNodeInfo root = window.getRoot(); if (root != null) roots.add(root); }
  AccessibilityNodeInfo active = ui.getRootInActiveWindow(); if (active != null) roots.add(active);
  ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>(roots);
  while (!queue.isEmpty()) { AccessibilityNodeInfo node = queue.remove(); if (node.isVisibleToUser() && match.test(node)) return node; for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo child = node.getChild(i); if (child != null) queue.add(child); } }
  return null;
 }
 private static String text(AccessibilityNodeInfo node) { return node == null || node.getText() == null ? "" : node.getText().toString(); }
 private void await(BooleanSupplier condition, String message) {
  long end = SystemClock.elapsedRealtime() + 15000;
  while (!condition.getAsBoolean() && SystemClock.elapsedRealtime() < end) SystemClock.sleep(100);
  boolean passed = condition.getAsBoolean();
  if (!passed) {
   android.graphics.Bitmap screenshot = ui.takeScreenshot();
   if (screenshot != null) {
    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes); screenshot.recycle();
    Bundle artifact = new Bundle(); artifact.putString("nativeArtifactName", "password-consumer-failure.png"); artifact.putString("nativeArtifactBase64", android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP));
    InstrumentationRegistry.getInstrumentation().sendStatus(2, artifact);
   }
  }
  assertTrue(message, passed);
 }
 private void press(String label) {
  await(() -> find(node -> label.equalsIgnoreCase(text(node))) != null, "Missing control: " + label);
  AccessibilityNodeInfo node = find(item -> label.equalsIgnoreCase(text(item)));
  while (node != null && !node.isClickable()) node = node.getParent();
  assertNotNull("Clickable control: " + label, node);
  assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK));
 }
 private AccessibilityNodeInfo field(String label) { return find(node -> node.isEditable() && label.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription())); }
 private void focus(String label) {
  await(() -> { AccessibilityNodeInfo node = field(label); return node != null && (node.isFocused() || node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)); }, "Synthetic field accepts focus: " + label);
 }
 private void input(String label, String value) {
  focus(label);
  await(() -> find(item -> "Fill with a saved password".equals(text(item))) != null, "Framework offer ready for focused field");
  Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
  await(() -> { AccessibilityNodeInfo node = field(label); return node != null && node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args); }, "Native field accepts user edit");
 }
 private void credentialPrompt() {
  await(() -> find(node -> node.isPassword() && node.isEditable() && !"example.passwords.fixture".contentEquals(node.getPackageName() == null ? "" : node.getPackageName())) != null, "Device credential prompt");
 }
 private void pin(String value) throws Exception {
  credentialPrompt();
  shell("input text " + value); shell("input keyevent 66");
 }
 /** Draw only our synthetic provider sheet for layout review. Do not disable FLAG_SECURE. */
 private void captureSheet(Class<?> type, String name) throws Exception {
  java.util.concurrent.atomic.AtomicReference<android.app.Activity> selected = new java.util.concurrent.atomic.AtomicReference<>();
  java.util.concurrent.CountDownLatch laidOut = new java.util.concurrent.CountDownLatch(1);
  InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
   android.app.Activity activity = null;
   for (Stage stage : Stage.values()) for (android.app.Activity owner : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage)) if (type.isInstance(owner) && !owner.isFinishing()) activity = owner;
   assertNotNull("Provider Activity available for layout review", activity);
   selected.set(activity);
   android.view.View decor = activity.getWindow().getDecorView();
   decor.postOnAnimation(() -> decor.postOnAnimation(laidOut::countDown));
  });
  assertTrue("Native sheet layout settled", laidOut.await(5, java.util.concurrent.TimeUnit.SECONDS));
  InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
   android.app.Activity activity = selected.get();
   assertTrue("Screen capture remains blocked", (activity.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0);
   android.view.View view = activity.getWindow().getDecorView();
   assertTrue(view.getWidth() > 0 && view.getHeight() > 0);
   android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(view.getWidth(), view.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
   view.draw(new android.graphics.Canvas(bitmap));
   java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
   assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes)); bitmap.recycle();
   Bundle artifact = new Bundle(); artifact.putString("nativeArtifactName", name); artifact.putString("nativeArtifactBase64", android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP));
   InstrumentationRegistry.getInstrumentation().sendStatus(2, artifact);
  });
 }
 private void launch(Context context, String username, String password) {
  context.startActivity(new Intent().setClassName("example.passwords.fixture", "example.passwords.fixture.LoginActivity").putExtra("expectedUsername", username).putExtra("expectedPassword", password).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
  focus("Test username");
  await(() -> find(node -> "Fill with a saved password".equals(text(node))) != null, "Framework admitted the form before edits");
 }
 @Test public void saveAndFillRequireUserUnlockAndChoice() throws Exception {
  assertEquals("1", InstrumentationRegistry.getArguments().getString("disposablePasswordFixture"));
  Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
  assertTrue("Owned emulator only", shell("getprop ro.hardware").matches("ranchu|goldfish|cutf_cvm"));
  String user = shell("am get-current-user"); assertTrue(user.matches("[0-9]+")); assertNotEquals("0", user);
  KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
  assertFalse("Fixture user starts without a screen lock", keyguard.isDeviceSecure());
  String pin = "7" + (100000 + new java.security.SecureRandom().nextInt(800000));
  String username = "synthetic-" + UUID.randomUUID().toString().substring(0, 8);
  String password = "Synthetic-only-" + UUID.randomUUID().toString();
  AccessibilityServiceInfo info = ui.getServiceInfo(); info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS; ui.setServiceInfo(info);
  String previous = shell("settings --user " + user + " get secure autofill_service");
  assertTrue(previous.isEmpty() || previous.equals("null") || previous.matches("[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+"));
  boolean ownPin = false;
  try {
   shell("locksettings set-pin --user " + user + " " + pin); ownPin = true;
   await(keyguard::isDeviceSecure, "Synthetic screen lock ready");
   String service = context.getPackageName() + "/ai.eliza.plugins.passwords.ElizaPasswordAutofillService";
   shell("settings --user " + user + " put secure autofill_service " + service);
   assertEquals(service, shell("settings --user " + user + " get secure autofill_service"));
   android.view.autofill.AutofillManager manager = context.getSystemService(android.view.autofill.AutofillManager.class);
   await(() -> android.content.ComponentName.unflattenFromString(service).equals(manager.getAutofillServiceComponentName()), "Framework observed the selected provider");
   launch(context, username, password); input("Test username", username); input("Test password", password);
   press("Check filled values");
   await(() -> find(node -> "Both synthetic fields match".equals(text(node))) != null, "Both synthetic edits reached the form");
   press("Submit synthetic form");
   press("SAVE");
   await(() -> find(node -> "Save password?".equals(text(node))) != null, "Provider save confirmation");
   captureSheet(PasswordSaveActivity.class, "password-save-sheet.png");
   press("Save"); pin(pin);
   PasswordVaultAccess access = PasswordVaultAccess.get(context);
   await(() -> new File(access.config.directory, "vault.enc").isFile(), "Authenticated save wrote encrypted vault");
   await(() -> !access.unlocked(), "Save sheet closes its grant");
   launch(context, username, password);
   press("Fill with a saved password"); credentialPrompt();
   assertTrue("Picker owns a pending challenge", access.pending());
   boolean[] destroyed = {false};
   InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
    for (Stage stage : Stage.values()) for (android.app.Activity owner : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage)) {
     if (owner instanceof PasswordFillActivity && !owner.isFinishing()) { destroyed[0] = true; owner.finish(); }
    }
   });
   assertTrue("Real picker Activity closed during authentication", destroyed[0]);
   await(() -> !access.pending() && !access.unlocked(), "Abandoned picker cancels its challenge");
   await(() -> { AccessibilityNodeInfo userField = field("Test username"), passwordField = field("Test password"); return userField != null && passwordField != null && userField.isShowingHintText() && passwordField.isShowingHintText(); }, "Cancelled picker leaves both fields empty");
   launch(context, username, password);
   press("Fill with a saved password"); pin(pin);
   await(() -> find(node -> text(node).contains(username)) != null, "Picker displays the captured account");
   captureSheet(PasswordFillActivity.class, "password-fill-sheet.png");
   AccessibilityNodeInfo choice = find(node -> text(node).contains(username));
   while (choice != null && !choice.isClickable()) choice = choice.getParent();
   assertNotNull(choice); assertTrue(choice.performAction(AccessibilityNodeInfo.ACTION_CLICK));
   await(() -> field("Test username") != null && username.equals(text(field("Test username"))), "Framework filled the selected account");
   // Android masks password accessibility text. The target confirms only equality, never the value.
   press("Check filled values");
   await(() -> find(node -> "Both synthetic fields match".equals(text(node))) != null, "Both fields match the synthetic input");
   await(() -> !access.unlocked(), "Picker closes its grant");
  } finally {
   if (previous.isEmpty() || previous.equals("null")) shell("settings --user " + user + " delete secure autofill_service");
   else shell("settings --user " + user + " put secure autofill_service " + previous);
   if (ownPin) shell("locksettings clear --user " + user + " --old " + pin);
  }
 }
}

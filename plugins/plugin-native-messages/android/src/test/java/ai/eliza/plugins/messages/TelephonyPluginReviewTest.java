package ai.eliza.plugins.messages;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Application;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;
import android.telephony.SubscriptionManager;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowSubscriptionManager;

/** The real bridge methods over controlled worker scheduling. No radio or provider effect. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class TelephonyPluginReviewTest {
  public static final class Receiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {}
  }
  static final class Call extends PluginCall {
    volatile JSObject result;
    volatile String error;
    volatile int resolutions;
    Call(String method, JSObject data) { super(null, "Telephony", method, method, data); }
    @Override public void resolve() { resolutions++; }
    @Override public void resolve(JSObject value) { result = value; resolutions++; }
    @Override public void reject(String message, String code, Exception cause, JSObject data) { error = code; }
  }
  static final class Host extends TelephonyPlugin {
    final AppCompatActivity activity;
    Host(AppCompatActivity activity) { this.activity = activity; }
    @Override public Context getContext() { return activity; }
    @Override public AppCompatActivity getActivity() { return activity; }
    @Override public PermissionState getPermissionState(String alias) { return PermissionState.GRANTED; }
    @Override protected SmsTelephonyConfiguration configuration() { throw new AssertionError("fixture installs its configuration"); }
    void pause() { handleOnPause(); }
  }
  private Host host(String identity) throws Exception {
    AppCompatActivity activity = Robolectric.buildActivity(AppCompatActivity.class).get();
    activity.setTheme(android.R.style.Theme_Material_Light);
    Shadows.shadowOf((Application) activity.getApplicationContext()).grantPermissions(Manifest.permission.READ_PHONE_STATE);
    Shadows.shadowOf(activity.getSystemService(UserManager.class)).setUserUnlocked(true);
    Shadows.shadowOf(activity.getSystemService(KeyguardManager.class)).setIsDeviceLocked(false);
    Shadows.shadowOf(activity.getSystemService(TelephonyManager.class)).setIsSmsCapable(true);
    Shadows.shadowOf(activity.getSystemService(SubscriptionManager.class)).setActiveSubscriptionInfos(ShadowSubscriptionManager.SubscriptionInfoBuilder.newBuilder().setId(1).setSimSlotIndex(0).setDisplayName("Test SIM").setCarrierName("Test carrier").buildSubscriptionInfo());
    Host host = new Host(activity);
    Map<String, String> slots = new HashMap<>();
    SmsTelephonyConfiguration config = new SmsTelephonyConfiguration(identity, null, identity, "fixture.sent", "fixture.delivered", "fixture", "operation", "index", "fixture.image", Receiver.class, context -> true, context -> new SmsTelephonyConfiguration.JournalStore() {
      public String read(String slot) { return slots.get(slot); }
      public void write(String slot, String value) { slots.put(slot, value); }
    });
    Field configured = TelephonyPlugin.class.getDeclaredField("config"); configured.setAccessible(true); configured.set(host, config);
    return host;
  }
  private static Call send(String method) {
    return new Call(method, new JSObject().put("operationId", "cancel-1").put("recipients", new JSArray(Collections.singletonList("+15555550123"))).put("body", "Original reviewed text").put("subscriptionId", 1).put("attachments", new JSArray()));
  }
  private static void noRadioAndNoRetainedOwner(Host host) throws Exception {
    assertNull(Shadows.shadowOf(SmsManager.getSmsManagerForSubscriptionId(1)).getLastSentTextMessageParams());
    assertNull(Shadows.shadowOf(SmsManager.getSmsManagerForSubscriptionId(1)).getLastSentMultimediaMessageParams());
    Field owners = TelephonyPlugin.class.getDeclaredField("pendingReviews"); owners.setAccessible(true);
    assertTrue("settlement releases the pending owner", ((java.util.Set<?>) owners.get(host)).isEmpty());
  }
  @Test public void smsCancellationBeforeJournalReplyMustRetireQueuedReview() throws Exception { queuedCancellation("sendSms", false); }
  @Test public void mmsCancellationBeforeJournalReplyMustRetireQueuedReview() throws Exception { queuedCancellation("sendMms", false); }
  @Test public void backgroundBeforeJournalReplyMustRetireQueuedReview() throws Exception { queuedCancellation("sendSms", true); }
  private void queuedCancellation(String method, boolean background) throws Exception {
    Host host = host(method.toLowerCase(java.util.Locale.ROOT) + (background ? "-background" : "-cancel"));
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    SmsTelephony.WORK.execute(() -> {
      entered.countDown();
      try { assertTrue(release.await(10, TimeUnit.SECONDS)); } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
    });
    assertTrue(entered.await(10, TimeUnit.SECONDS));
    Call send = send(method);
    Call cancel = new Call("cancelSmsReview", new JSObject().put("operationId", "cancel-1"));
    try {
      if (method.equals("sendSms")) host.sendSms(send); else host.sendMms(send);
      if (background) host.pause(); else host.cancelSmsReview(cancel);
      ShadowLooper.idleMainLooper();
      if (!background) assertEquals("cancellation has already acknowledged", 1, cancel.resolutions);
      release.countDown();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      ShadowLooper.idleMainLooper();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      assertNotNull("retired send must settle explicitly", send.result);
      assertEquals("a cancellation must not become a later denial or native review", "cancelled", send.result.getString("status"));
      AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog();
      assertTrue("no retired review is shown", shown == null || !shown.isShowing());
      assertEquals(1, send.resolutions);
      noRadioAndNoRetainedOwner(host);
    } finally {
      release.countDown();
      AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog(); if (shown != null) shown.dismiss();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    }
  }
  @Test public void cancellationAfterSendTapFencesQueuedDispatch() throws Exception {
    Host host = host("after-tap");
    Call send = send("sendSms");
    host.sendSms(send);
    SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    ShadowLooper.idleMainLooper();
    AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog();
    assertNotNull(shown);
    assertTrue(shown.isShowing());
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    SmsTelephony.WORK.execute(() -> {
      entered.countDown();
      try { assertTrue(release.await(10, TimeUnit.SECONDS)); } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
    });
    assertTrue(entered.await(10, TimeUnit.SECONDS));
    try {
      shown.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();
      ShadowLooper.idleMainLooper();
      Call cancel = new Call("cancelSmsReview", new JSObject().put("operationId", "cancel-1"));
      host.cancelSmsReview(cancel);
      ShadowLooper.idleMainLooper();
      assertEquals(1, cancel.resolutions);
      release.countDown();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      assertNotNull(send.result);
      assertEquals("cancelled", send.result.getString("status"));
      assertEquals(1, send.resolutions);
      noRadioAndNoRetainedOwner(host);
    } finally {
      release.countDown();
      shown.dismiss();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    }
  }
  @Test public void unrelatedCancellationCannotRetireAnotherReview() throws Exception {
    Host host = host("unrelated");
    Call send = send("sendSms");
    host.sendSms(send);
    SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    ShadowLooper.idleMainLooper();
    AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog();
    assertNotNull(shown);
    try {
      Call other = new Call("cancelSmsReview", new JSObject().put("operationId", "other-operation"));
      host.cancelSmsReview(other);
      ShadowLooper.idleMainLooper();
      assertEquals(1, other.resolutions);
      assertTrue(shown.isShowing());
      assertNull(send.result);
      shown.dismiss();
      ShadowLooper.idleMainLooper();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      assertEquals("cancelled", send.result.getString("status"));
      noRadioAndNoRetainedOwner(host);
    } finally { shown.dismiss(); }
  }
  @Test public void cancellationCannotEraseARecordedSubmission() throws Exception {
    Host host = host("recorded");
    Field configured = TelephonyPlugin.class.getDeclaredField("config"); configured.setAccessible(true);
    SmsSendJournal journal = SmsTelephony.journal(host.getContext(), (SmsTelephonyConfiguration) configured.get(host));
    journal.beginDispatch("cancel-1", new String[]{"+15555550123"}, "Original reviewed text", 1, new int[]{1}, System.currentTimeMillis(), SmsTelephony.boot(host.getContext()));
    journal.endDispatch("cancel-1", true);
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    SmsTelephony.WORK.execute(() -> {
      entered.countDown();
      try { assertTrue(release.await(10, TimeUnit.SECONDS)); } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
    });
    assertTrue(entered.await(10, TimeUnit.SECONDS));
    try {
      Call send = send("sendSms");
      host.sendSms(send);
      Call cancel = new Call("cancelSmsReview", new JSObject().put("operationId", "cancel-1"));
      host.cancelSmsReview(cancel);
      ShadowLooper.idleMainLooper();
      assertEquals(1, cancel.resolutions);
      release.countDown();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
      assertEquals("submitted", send.result.getString("status"));
      assertEquals(1, send.resolutions);
      noRadioAndNoRetainedOwner(host);
    } finally {
      release.countDown();
      SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    }
  }
}

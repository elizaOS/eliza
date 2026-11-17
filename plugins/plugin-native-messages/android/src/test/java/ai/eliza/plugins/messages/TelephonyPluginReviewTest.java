package ai.eliza.plugins.messages;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Application;
import android.app.KeyguardManager;
import android.app.role.RoleManager;
import android.content.BroadcastReceiver;
import android.content.ContentProvider;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.UserManager;
import android.provider.Telephony;
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
  public static final class OutboxProvider extends ContentProvider {
    private static final long OWN_ROW = 12;
    final Map<Long, ContentValues> outbox = new HashMap<>();
    int parts;
    int deletes;
    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String sort) {
      MatrixCursor thread = new MatrixCursor(new String[] {"_id"});
      thread.addRow(new Object[] {1});
      return thread;
    }
    @Override public Uri insert(Uri uri, ContentValues values) {
      if (uri.equals(Telephony.Mms.Outbox.CONTENT_URI)) {
        ContentValues own = new ContentValues(values);
        own.put(Telephony.Mms.CREATOR, getContext().getPackageName());
        outbox.put(OWN_ROW, own);
        ContentValues other = new ContentValues(own);
        other.put(Telephony.Mms.TRANSACTION_ID, "another-send");
        outbox.put(OWN_ROW + 1, other);
        return ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI, OWN_ROW);
      }
      if ("part".equals(uri.getLastPathSegment())) parts++;
      return ContentUris.withAppendedId(uri, 1);
    }
    @Override public int delete(Uri uri, String selection, String[] args) {
      assertEquals(Telephony.Mms.CONTENT_URI, uri);
      assertEquals("_id = ? AND msg_box = ? AND creator = ? AND tr_id = ?", selection);
      assertArrayEquals(new String[] {Long.toString(OWN_ROW), Integer.toString(Telephony.Mms.MESSAGE_BOX_OUTBOX),
        getContext().getPackageName(), SmsTelephony.mmsTransaction("cancel-1")}, args);
      deletes++;
      return outbox.remove(OWN_ROW) == null ? 0 : 1;
    }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri uri) { return null; }
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
    boolean imageAllowed=true, smsAllowed=true;
    Host(AppCompatActivity activity) { this.activity = activity; }
    @Override public Context getContext() { return activity; }
    @Override public AppCompatActivity getActivity() { return activity; }
    @Override public PermissionState getPermissionState(String alias) { return alias.equals("sms") && !smsAllowed ? PermissionState.DENIED : PermissionState.GRANTED; }
    @Override protected SmsTelephonyConfiguration configuration() { throw new AssertionError("fixture installs its configuration"); }
    void pause() { handleOnPause(); }
    void sendFromComposer(Call call, SmsTelephony.DispatchGuard guard) {
      if (call.getMethodName().equals("sendMms")) sendOwnerApprovedMms(call, guard);
      else sendOwnerApprovedSms(call, guard);
    }
  }
  private Host host(String identity) throws Exception { return host(identity, false); }
  private Host host(String identity, boolean mms) throws Exception {
    AppCompatActivity activity = Robolectric.buildActivity(AppCompatActivity.class).get();
    activity.setTheme(android.R.style.Theme_Material_Light);
    Shadows.shadowOf((Application) activity.getApplicationContext()).grantPermissions(Manifest.permission.READ_PHONE_STATE);
    Shadows.shadowOf(activity.getSystemService(UserManager.class)).setUserUnlocked(true);
    Shadows.shadowOf(activity.getSystemService(KeyguardManager.class)).setIsDeviceLocked(false);
    Shadows.shadowOf(activity.getSystemService(TelephonyManager.class)).setIsSmsCapable(true);
    Shadows.shadowOf(activity.getSystemService(SubscriptionManager.class)).setActiveSubscriptionInfos(ShadowSubscriptionManager.SubscriptionInfoBuilder.newBuilder().setId(1).setSimSlotIndex(0).setDisplayName("Test SIM").setCarrierName("Test carrier").buildSubscriptionInfo());
    Host host = new Host(activity);
    Map<String, String> slots = new HashMap<>();
    SmsTelephonyConfiguration config = new SmsTelephonyConfiguration(identity, null, identity, "fixture.sent", "fixture.delivered", "fixture", "operation", "index", "fixture.image", Receiver.class, context -> host.imageAllowed, context -> new SmsTelephonyConfiguration.JournalStore() {
      public String read(String slot) { return slots.get(slot); }
      public void write(String slot, String value) { slots.put(slot, value); }
    });
    Field configured = TelephonyPlugin.class.getDeclaredField("config"); configured.setAccessible(true);
    configured.set(host, mms ? config.withMmsFiles("fixture.mms") : config);
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
  @Test public void smsEligibilityMatchesTypedMmsReceiverAndEnabledHostComponents() throws Exception {
    Host host = host("role-eligibility");
    PackageManager manager = host.getContext().getPackageManager();
    var packages = Shadows.shadowOf(manager);
    String self = host.getContext().getPackageName();
    ComponentName sms = new ComponentName(self, self + ".SmsReceiver");
    ComponentName mms = new ComponentName(self, self + ".MmsReceiver");
    ComponentName responder = new ComponentName(self, self + ".MessageResponder");
    ComponentName composer = new ComponentName(self, self + ".MessageComposer");
    packages.addReceiverIfNotPresent(sms).enabled = true;
    packages.addIntentFilterForReceiver(sms, new IntentFilter(Telephony.Sms.Intents.SMS_DELIVER_ACTION));
    packages.addReceiverIfNotPresent(mms).enabled = true;
    IntentFilter mmsFilter = new IntentFilter(Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION);
    mmsFilter.addDataType("application/vnd.wap.mms-message");
    packages.addIntentFilterForReceiver(mms, mmsFilter);
    packages.addServiceIfNotPresent(responder).enabled = true;
    IntentFilter respondFilter = new IntentFilter(TelephonyManager.ACTION_RESPOND_VIA_MESSAGE);
    respondFilter.addDataScheme("smsto");
    packages.addIntentFilterForService(responder, respondFilter);
    packages.addActivityIfNotPresent(composer).enabled = true;
    IntentFilter composeFilter = new IntentFilter(Intent.ACTION_SENDTO);
    composeFilter.addDataScheme("smsto");
    packages.addIntentFilterForActivity(composer, composeFilter);

    // Exercise Android IntentFilter resolution, not a preselected ResolveInfo response.
    assertTrue(manager.queryBroadcastReceivers(new Intent(Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION).setPackage(self), 0).isEmpty());
    assertEquals(1, manager.queryBroadcastReceivers(new Intent(Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION)
      .setType("application/vnd.wap.mms-message").setPackage(self), 0).size());
    assertTrue("a MIME-qualified enabled host can be offered the SMS role", host.eligibleFor(RoleManager.ROLE_SMS));
    assertTrue(host.statusObject().getJSONObject("roles").getJSONObject("sms").getBoolean("eligible"));
    for (ComponentName component : new ComponentName[] {sms, mms, responder, composer}) {
      manager.setComponentEnabledSetting(component, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
      assertFalse("every host component remains required", host.eligibleFor(RoleManager.ROLE_SMS));
      manager.setComponentEnabledSetting(component, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
      assertTrue(host.eligibleFor(RoleManager.ROLE_SMS));
    }
    ComponentName foreign = new ComponentName("other.messages", "other.messages.MmsReceiver");
    packages.addReceiverIfNotPresent(foreign).enabled = true;
    packages.addIntentFilterForReceiver(foreign, mmsFilter);
    manager.setComponentEnabledSetting(mms, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
    assertFalse("a foreign receiver cannot qualify this host", host.eligibleFor(RoleManager.ROLE_SMS));
    assertFalse(host.getContext().getSystemService(RoleManager.class).isRoleHeld(RoleManager.ROLE_SMS));
    noRadioAndNoRetainedOwner(host);
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
  private static void settleComposer() throws Exception {
    SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    ShadowLooper.idleMainLooper();
    SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
    SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
  }
  @Test public void ownerApprovedSmsUsesTheSameReceiptWithoutDialogOrReplay() throws Exception {
    Host host = host("owner-sms");
    RoleManager roles = host.getContext().getSystemService(RoleManager.class);
    Shadows.shadowOf(roles).addAvailableRole(RoleManager.ROLE_SMS);
    Call send = send("sendSms");
    host.sendFromComposer(send, () -> {});
    settleComposer();
    AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog();
    assertTrue(shown == null || !shown.isShowing());
    assertEquals("submitted", send.result.getString("status"));
    var manager = Shadows.shadowOf(SmsManager.getSmsManagerForSubscriptionId(1));
    assertNotNull(manager.getLastSentTextMessageParams());
    manager.clearLastSentTextMessageParams();

    Call repeat = send("sendSms");
    host.sendSms(repeat);
    settleComposer();
    assertEquals("submitted", repeat.result.getString("status"));
    noRadioAndNoRetainedOwner(host);
  }
  @Test public void ownerApprovedMmsUsesTheSameReceiptWithoutDialogOrReplay() throws Exception {
    Host host = host("owner-mms", true);
    RoleManager roles = host.getContext().getSystemService(RoleManager.class);
    Shadows.shadowOf(roles).addHeldRole(RoleManager.ROLE_SMS);
    Call send = send("sendMms");
    host.sendFromComposer(send, () -> {});
    settleComposer();
    AlertDialog shown = ShadowAlertDialog.getLatestAlertDialog();
    assertTrue(shown == null || !shown.isShowing());
    assertEquals("submitted", send.result.getString("status"));
    var manager = Shadows.shadowOf(SmsManager.getSmsManagerForSubscriptionId(1));
    assertNotNull(manager.getLastSentMultimediaMessageParams());
    manager.clearLastSentMultimediaMessageParams();

    Call repeat = send("sendMms");
    host.sendMms(repeat);
    settleComposer();
    assertEquals("submitted", repeat.result.getString("status"));
    noRadioAndNoRetainedOwner(host);
  }
  @Test public void withdrawnComposerApprovalCannotDispatchOrBeReplayed() throws Exception {
    Host host = host("owner-withdrawn");
    Call send = send("sendSms");
    host.sendFromComposer(send, () -> { throw new IllegalStateException("Composer approval withdrawn"); });
    settleComposer();
    assertEquals("denied", send.result.getString("status"));

    Call repeat = send("sendSms");
    host.sendFromComposer(repeat, () -> {});
    settleComposer();
    assertEquals("denied", repeat.result.getString("status"));
    noRadioAndNoRetainedOwner(host);
  }
  @Test public void mmsRetiredAfterStagingRollsBackOnlyItsOwnRow() throws Exception {
    Host host = host("owner-mms-retired", true);
    RoleManager roles = host.getContext().getSystemService(RoleManager.class);
    Shadows.shadowOf(roles).addHeldRole(RoleManager.ROLE_SMS);
    ProviderInfo threads = new ProviderInfo(); threads.authority = "mms-sms";
    Robolectric.buildContentProvider(OutboxProvider.class).create(threads);
    ProviderInfo messages = new ProviderInfo(); messages.authority = "mms";
    OutboxProvider provider = Robolectric.buildContentProvider(OutboxProvider.class).create(messages).get();
    Call send = send("sendMms");
    host.sendFromComposer(send, () -> {
      if (!provider.outbox.isEmpty()) throw new IllegalStateException("Composer retired during provider staging");
    });
    settleComposer();
    assertEquals("denied", send.result.getString("status"));
    assertEquals(1, provider.parts);
    assertEquals(1, provider.deletes);
    assertEquals(Collections.singleton(OutboxProvider.OWN_ROW + 1), provider.outbox.keySet());
    assertEquals(0, MmsStore.directory(host.getContext()).list().length);

    Call repeat = send("sendMms");
    host.sendFromComposer(repeat, () -> {});
    settleComposer();
    assertEquals("denied", repeat.result.getString("status"));
    assertEquals(1, provider.deletes);
    noRadioAndNoRetainedOwner(host);
  }
  public static final class DeleteProvider extends ContentProvider {
    static int reads,writes; static Runnable onRead,onDelete;
    @Override public boolean onCreate(){return true;}
    @Override public String getType(Uri uri){return null;}
    @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String where,String[]args){throw new UnsupportedOperationException();}
    @Override public Cursor query(Uri uri,String[]projection,String where,String[]args,String order){
      reads++;MatrixCursor row=new MatrixCursor(new String[]{"_id","thread_id","date"});row.addRow(new Object[]{7,9,1700000000123L});
      Runnable action=onRead;onRead=null;if(action!=null)action.run();return row;
    }
    @Override public int delete(Uri uri,String where,String[]args){
      writes++;assertEquals(Telephony.Sms.CONTENT_URI,uri);Runnable action=onDelete;onDelete=null;if(action!=null)action.run();return 1;
    }
  }
  private static void settleDeletion(Host host)throws Exception{
    Field field=TelephonyPlugin.class.getDeclaredField("reader");field.setAccessible(true);
    java.util.concurrent.ExecutorService reader=(java.util.concurrent.ExecutorService)field.get(host);
    reader.submit(()->{}).get(10,TimeUnit.SECONDS);ShadowLooper.idleMainLooper();
  }
  private static Call deleteCall(){
    JSObject data=new JSObject();data.put("id","sms:7");data.put("kind","sms");data.put("threadId","thread:9");data.put("date",1700000000123L);return new Call("deleteMessage",data);
  }
  private static void deleteProvider(){
    DeleteProvider.reads=DeleteProvider.writes=0;DeleteProvider.onRead=DeleteProvider.onDelete=null;
    ProviderInfo info=new ProviderInfo();info.authority="sms";Robolectric.buildContentProvider(DeleteProvider.class).create(info);
  }
  @Test public void deleteRequiresImageForegroundUnlockedDefaultSmsAndReadAuthority()throws Exception{
    deleteProvider();Host denied=host("delete-image");denied.imageAllowed=false;Call call=deleteCall();denied.deleteMessage(call);assertEquals("unavailable",call.error);
    Host background=host("delete-background");background.pause();call=deleteCall();background.deleteMessage(call);assertEquals("unavailable",call.error);
    Host ordinary=host("delete-role");call=deleteCall();ordinary.deleteMessage(call);assertEquals("role-required",call.error);
    Host permission=host("delete-permission");Shadows.shadowOf(permission.getContext().getSystemService(RoleManager.class)).addHeldRole(RoleManager.ROLE_SMS);permission.smsAllowed=false;
    call=deleteCall();permission.deleteMessage(call);assertEquals("permission-required",call.error);
    Host locked=host("delete-locked");Shadows.shadowOf(locked.getContext().getSystemService(KeyguardManager.class)).setIsDeviceLocked(true);call=deleteCall();locked.deleteMessage(call);assertEquals("unavailable",call.error);
    assertEquals(0,DeleteProvider.reads);assertEquals(0,DeleteProvider.writes);
  }
  @Test public void deleteRechecksLifecycleBeforeEffectAndKeepsKnownContentFreeOutcomeAfterwards()throws Exception{
    deleteProvider();Host before=host("delete-race");Shadows.shadowOf(before.getContext().getSystemService(RoleManager.class)).addHeldRole(RoleManager.ROLE_SMS);
    DeleteProvider.onRead=before::pause;Call denied=deleteCall();before.deleteMessage(denied);settleDeletion(before);
    assertEquals("unavailable",denied.error);assertEquals(0,DeleteProvider.writes);
    Host after=host("delete-known");DeleteProvider.onDelete=()->{after.smsAllowed=false;after.pause();};Call known=deleteCall();after.deleteMessage(known);settleDeletion(after);
    assertNull(known.error);assertEquals("deleted",known.result.getString("status"));assertEquals(1,DeleteProvider.writes);
  }

  @Test @Config(sdk=36) public void deleteRefusesANonForegroundAndroidUserProfile()throws Exception{
    deleteProvider();Host host=host("delete-profile");
    Shadows.shadowOf(host.getContext().getSystemService(RoleManager.class)).addHeldRole(RoleManager.ROLE_SMS);
    Shadows.shadowOf(host.getContext().getSystemService(UserManager.class)).setUserForeground(false);
    Call call=deleteCall();host.deleteMessage(call);
    assertEquals("unavailable",call.error);assertEquals(0,DeleteProvider.reads);assertEquals(0,DeleteProvider.writes);
  }
  @Test public void deleteRechecksRoleAndReadPermissionDuringIdentityLookup()throws Exception{
    for(boolean roleLoss:new boolean[]{true,false}){
      deleteProvider();Host host=host(roleLoss?"delete-role-race":"delete-permission-race");
      RoleManager roles=host.getContext().getSystemService(RoleManager.class);Shadows.shadowOf(roles).addHeldRole(RoleManager.ROLE_SMS);
      DeleteProvider.onRead=()->{if(roleLoss)Shadows.shadowOf(roles).removeHeldRole(RoleManager.ROLE_SMS);else host.smsAllowed=false;};
      Call call=deleteCall();host.deleteMessage(call);settleDeletion(host);
      assertEquals("unavailable",call.error);assertEquals(0,DeleteProvider.writes);
    }
  }

}

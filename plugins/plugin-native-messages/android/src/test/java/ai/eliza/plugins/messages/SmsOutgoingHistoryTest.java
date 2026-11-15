package ai.eliza.plugins.messages;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Application;
import android.app.role.RoleManager;
import android.content.BroadcastReceiver;
import android.content.ContentProvider;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import android.telephony.SmsManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowSmsManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class SmsOutgoingHistoryTest {
 private static final String BODY = "Reviewed text";
 private static final int SUBSCRIPTION = 1;
 private static final String[] RECIPIENTS = {"+15555550123", "+15555550124"};

 public static final class Receiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {}
 }

 public static final class Provider extends ContentProvider {
  final Map<Long, ContentValues> rows = new LinkedHashMap<>();
  int inserts;
  int refuse;
  int revokeRole;

  @Override public boolean onCreate() { return true; }
  @Override public Uri insert(Uri uri, ContentValues values) {
   assertEquals(Telephony.Sms.Outbox.CONTENT_URI, uri);
   assertNull(radio().getLastSentTextMessageParams());
   inserts++;
   if (inserts == refuse) return null;
   ContentValues stored = new ContentValues(values);
   stored.put(Telephony.Sms.CREATOR, getContext().getPackageName());
   rows.put((long) inserts, stored);
   if (inserts == revokeRole) Shadows.shadowOf(getContext().getSystemService(RoleManager.class)).removeHeldRole(RoleManager.ROLE_SMS);
   return ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, inserts);
  }
  private ContentValues ownedOutbox(long id, String type, String creator) {
   ContentValues row = rows.get(id);
   return row != null && row.getAsString(Telephony.Sms.TYPE).equals(type)
    && row.getAsString(Telephony.Sms.CREATOR).equals(creator) ? row : null;
  }
  @Override public int delete(Uri uri, String selection, String[] args) {
   assertEquals(Telephony.Sms.CONTENT_URI, uri);
   assertEquals("_id = ? AND type = ? AND creator = ?", selection);
   long id = Long.parseLong(args[0]);
   if (ownedOutbox(id, args[1], args[2]) == null) return 0;
   rows.remove(id);
   return 1;
  }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
   assertEquals("type = ? AND creator = ?", selection);
   ContentValues row = ownedOutbox(ContentUris.parseId(uri), args[0], args[1]);
   if (row == null) return 0;
   row.putAll(values);
   return 1;
  }
  @Override public Cursor query(Uri uri, String[] p, String where, String[] args, String order) { throw new UnsupportedOperationException(); }
  @Override public String getType(Uri uri) { return null; }
 }

 private Application app;
 private Provider provider;

 @Before public void setup() {
  app = RuntimeEnvironment.getApplication();
  Shadows.shadowOf(app).grantPermissions(Manifest.permission.SEND_SMS);
  RoleManager roles = app.getSystemService(RoleManager.class);
  Shadows.shadowOf(roles).addAvailableRole(RoleManager.ROLE_SMS);
  Shadows.shadowOf(roles).addHeldRole(RoleManager.ROLE_SMS);
  assertNull(Telephony.Sms.getDefaultSmsPackage(app));
  ProviderInfo info = new ProviderInfo();
  info.authority = "sms";
  provider = Robolectric.buildContentProvider(Provider.class).create(info).get();
 }

 private static ShadowSmsManager radio() { return Shadows.shadowOf(SmsManager.getSmsManagerForSubscriptionId(SUBSCRIPTION)); }

 private SmsSendJournal.Record send(SmsSendJournal journal, String id) throws Exception {
  SmsTelephonyConfiguration config = new SmsTelephonyConfiguration("history", null, "history", "fixture.sent", "fixture.delivered",
   "fixture", "operation", "index", "fixture.image", Receiver.class, context -> true, context -> null);
  return SmsTelephony.dispatch(app, config, journal, id, RECIPIENTS, BODY, SUBSCRIPTION,
   new ArrayList<>(Collections.singletonList(BODY)), () -> {});
 }

 @Test public void roleHolderStoresEveryRecipientBeforeSendingAndSettlesFromReceipts() throws Exception {
  SmsSendJournal journal = new SmsSendJournal(new ReviewedSmsSendCoreTest.Memory());
  SmsSendJournal.Record record = send(journal, "history-success");
  assertEquals("submitted", record.status());
  assertNotNull(radio().getLastSentTextMessageParams());
  assertArrayEquals(new long[] {1, 2}, record.providerRow);
  for (long id : record.providerRow) {
   assertEquals(Integer.valueOf(Telephony.Sms.MESSAGE_TYPE_OUTBOX), provider.rows.get(id).getAsInteger(Telephony.Sms.TYPE));
   assertEquals(BODY, provider.rows.get(id).getAsString(Telephony.Sms.BODY));
  }
  journal.sentResult(record.operationId, 0, true);
  SmsTelephony.settleOwnRow(app, journal, record.operationId, 0);
  journal.sentResult(record.operationId, 1, true);
  SmsTelephony.settleOwnRow(app, journal, record.operationId, 1);
  assertEquals("sent", record.status());
  for (long id : record.providerRow) assertEquals(Integer.valueOf(Telephony.Sms.MESSAGE_TYPE_SENT), provider.rows.get(id).getAsInteger(Telephony.Sms.TYPE));
 }

 @Test public void providerRefusalKeepsAllRecipientsOffRadioAndPersistsDenial() throws Exception {
  provider.refuse = 2;
  ReviewedSmsSendCoreTest.Memory memory = new ReviewedSmsSendCoreTest.Memory();
  SmsSendJournal journal = new SmsSendJournal(memory);
  SmsSendJournal.Record record = send(journal, "history-refused");
  assertEquals(2, provider.inserts);
  assertTrue(provider.rows.isEmpty());
  assertNull(radio().getLastSentTextMessageParams());
  assertEquals("denied", record.status());
  assertEquals(0, record.parts());
  SmsSendJournal reloaded = new SmsSendJournal(memory);
  assertEquals("denied", reloaded.existing(record.operationId, record.bindingHash).status());
  assertThrows(IllegalStateException.class, () -> send(reloaded, record.operationId));
  assertEquals(2, provider.inserts);
  assertNull(radio().getLastSentTextMessageParams());
 }

 @Test public void quickReplyCannotSendOrReplayAfterProviderRefusal() throws Exception {
  provider.refuse = 1;
  Map<String, String> slots = new LinkedHashMap<>();
  ReviewedSmsSend.Host host = new ReviewedSmsSend.Host("quick-history", "quick-history", context -> new SmsTelephonyConfiguration.JournalStore() {
   public String read(String slot) { return slots.get(slot); }
   public void write(String slot, String value) { slots.put(slot, value); }
  });
  for (int press = 0; press < 2; press++) {
   AtomicReference<String> result = new AtomicReference<>();
   ReviewedSmsSend.send(app, host, "quick-refused", RECIPIENTS, BODY, SUBSCRIPTION, result::set);
   SmsTelephony.WORK.submit(() -> {}).get(10, TimeUnit.SECONDS);
   ShadowLooper.idleMainLooper();
   assertEquals("denied", result.get());
   assertNull(radio().getLastSentTextMessageParams());
  }
  assertEquals(1, provider.inserts);
  assertTrue(provider.rows.isEmpty());
 }

 @Test public void roleLossAfterStagingStopsTheSendAndDiscardsItsRows() throws Exception {
  provider.revokeRole = RECIPIENTS.length;
  SmsSendJournal journal = new SmsSendJournal(new ReviewedSmsSendCoreTest.Memory());
  SmsSendJournal.Record record = send(journal, "history-role-change");
  assertEquals(RECIPIENTS.length, provider.inserts);
  assertTrue(provider.rows.isEmpty());
  assertEquals("denied", record.status());
  assertEquals(0, record.parts());
  assertNull(radio().getLastSentTextMessageParams());
 }

 @Test public void unreadableOwnershipCannotBypassProviderPreparation() throws Exception {
  RoleManager roles = app.getSystemService(RoleManager.class);
  Shadows.shadowOf(roles).removeHeldRole(RoleManager.ROLE_SMS);
  Shadows.shadowOf(roles).removeAvailableRole(RoleManager.ROLE_SMS);
  SmsSendJournal journal = new SmsSendJournal(new ReviewedSmsSendCoreTest.Memory());
  assertEquals("denied", send(journal, "history-owner-unreadable").status());
  assertEquals(0, provider.inserts);
  assertNull(radio().getLastSentTextMessageParams());

  Shadows.shadowOf(roles).addAvailableRole(RoleManager.ROLE_SMS);
  assertEquals("submitted", send(journal, "history-owner-elsewhere").status());
  assertEquals(0, provider.inserts);
  assertNotNull(radio().getLastSentTextMessageParams());
 }
}

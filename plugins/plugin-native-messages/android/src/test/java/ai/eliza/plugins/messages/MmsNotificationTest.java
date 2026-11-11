package ai.eliza.plugins.messages;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import java.util.HashMap;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

/** Real notification/PendingIntent identities over a controlled provider. Never sends a message. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE, shadows = MmsNotificationTest.DelayedNotifications.class)
public final class MmsNotificationTest {
  @org.robolectric.annotation.Implements(NotificationManager.class)
  public static final class DelayedNotifications extends org.robolectric.shadows.ShadowNotificationManager {
    static volatile boolean hold;
    static volatile Notification pending;
    static volatile String tag;
    static java.util.concurrent.CountDownLatch queued;
    @org.robolectric.annotation.Implementation protected void notify(String selected, int id, Notification notice) {
      if (!hold) { super.notify(selected, id, notice); return; }
      tag = selected; pending = notice; queued.countDown();
    }
    void publish() { hold = false; super.notify(tag, MmsStore.NOTICE_ID, pending); }
  }
  public static final class Open extends Activity {}
  public static final class Compose extends Activity {}
  public static final class Receiver extends MmsResultReceiver {
    static SmsRoleConfiguration config;
    @Override protected SmsRoleConfiguration configuration() { return config; }
  }
  public static final class Provider extends ContentProvider {
    static final Map<String, Long> threads = new HashMap<>();
    static android.database.sqlite.SQLiteDatabase database;
    static boolean failMms;
    static int writes;
    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) {
      MatrixCursor rows = new MatrixCursor(columns);
      Long thread = threads.get(uri.toString());
      if (thread != null) rows.addRow(new Object[] {thread});
      return rows;
    }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
      writes++;
      if (failMms && uri.getAuthority().equals("mms")) throw new IllegalStateException("Controlled provider write failure");
      return database.update(uri.getAuthority(), values, selection, args);
    }
  }
  private Context context;
  private SmsRoleConfiguration config;
  @Before public void setUp() {
    context = RuntimeEnvironment.getApplication();
    DelayedNotifications.hold = false; DelayedNotifications.pending = null;
    DelayedNotifications.queued = new java.util.concurrent.CountDownLatch(1);
    Provider.threads.clear();
    Provider.database = android.database.sqlite.SQLiteDatabase.create(null);
    Provider.failMms = false; Provider.writes = 0;
    for (String table : new String[] {"sms", "mms"}) {
      Provider.database.execSQL("CREATE TABLE " + table + " (_id INTEGER PRIMARY KEY, thread_id INTEGER, type INTEGER, msg_box INTEGER, date INTEGER, read INTEGER, seen INTEGER)");
      ProviderInfo info = new ProviderInfo(); info.authority = table;
      Robolectric.buildContentProvider(Provider.class).create(info);
    }
    SmsTelephonyConfiguration telephony = new SmsTelephonyConfiguration("notices", null, "notices", "notice.sent", "notice.delivered", "notice", "operation", "index", "notice.feature", Receiver.class, app -> true, app -> { throw new AssertionError("no send journal is opened"); });
    config = new SmsRoleConfiguration(telephony, "notices", "Messages", android.R.drawable.ic_dialog_email, "notice.download", "notice.response", "notice.files", Receiver.class, Compose.class, Open.class);
    Receiver.config = config;
  }
  private Notification post(long row, long thread, String body) {
    Uri uri = Uri.parse("content://sms/" + row);
    Provider.threads.put(uri.toString(), thread);
    MmsStore.notifyIncoming(context, config, uri, "+15555550100", body);
    for (android.service.notification.StatusBarNotification notice : context.getSystemService(NotificationManager.class).getActiveNotifications())
      if (SmsRecords.threadId(thread).equals(notice.getTag())) return notice.getNotification();
    throw new AssertionError("missing conversation notification");
  }
  @Test public void hashCollidingThreadsKeepDistinctContentTargets() {
    long first = 1, second = 1L << 32;
    assertEquals(Long.hashCode(first), Long.hashCode(second));
    Notification one = post(1, first, "First conversation");
    Notification two = post(2, second, "Second conversation");
    assertNotEquals(one.contentIntent, two.contentIntent);
    assertEquals("thread:1", Shadows.shadowOf(one.contentIntent).getSavedIntent().getStringExtra(SmsRoleConfiguration.EXTRA_THREAD_ID));
    assertEquals("thread:4294967296", Shadows.shadowOf(two.contentIntent).getSavedIntent().getStringExtra(SmsRoleConfiguration.EXTRA_THREAD_ID));
  }
  @Test public void conversationRetainsItsMessagesAndReplyOnlyOpensCompose() {
    Notification previous = post(1, 7, "First full text");
    Notification notice = post(2, 7, "Second full text");
    assertTrue("replacement retires its prior read action", Shadows.shadowOf(previous.actions[1].actionIntent).isCanceled());
    java.util.List<Notification.MessagingStyle.Message> messages = Notification.MessagingStyle.Message.getMessagesFromBundleArray(notice.extras.getParcelableArray(Notification.EXTRA_MESSAGES));
    assertEquals(2, messages.size());
    assertEquals("First full text", messages.get(0).getText());
    assertEquals("Second full text", messages.get(1).getText());
    assertEquals("New message", notice.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE));
    assertNull(notice.publicVersion.extras.getCharSequence(Notification.EXTRA_TEXT));
    assertEquals(2, notice.actions.length);
    Intent reply = Shadows.shadowOf(notice.actions[0].actionIntent).getSavedIntent();
    assertEquals(Intent.ACTION_SENDTO, reply.getAction());
    assertEquals(Compose.class.getName(), reply.getComponent().getClassName());
    assertEquals("smsto", reply.getData().getScheme());
    assertEquals("+15555550100", reply.getData().getSchemeSpecificPart());
    assertNull(notice.actions[0].getRemoteInputs());
    Intent read = Shadows.shadowOf(notice.actions[1].actionIntent).getSavedIntent();
    assertEquals(MmsResultReceiver.ACTION_MARK_READ, read.getAction());
    assertEquals(7, read.getLongExtra(MmsResultReceiver.EXTRA_THREAD, 0));
    assertTrue(read.getLongExtra(MmsResultReceiver.EXTRA_THROUGH, 0) > 0);
    assertEquals(Receiver.class.getName(), read.getComponent().getClassName());
  }
  private static void unread(String table, long id, long thread, int type, long date) {
    ContentValues row = new ContentValues(); row.put("_id", id); row.put("thread_id", thread);
    row.put("type", type); row.put("msg_box", type); row.put("date", date); row.put("read", 0); row.put("seen", 0);
    assertTrue(Provider.database.insertOrThrow(table, null, row) > 0);
  }
  private static int read(String table, long id) {
    try (Cursor row = Provider.database.rawQuery("SELECT read FROM " + table + " WHERE _id=?", new String[] {Long.toString(id)})) { assertTrue(row.moveToFirst()); return row.getInt(0); }
  }
  private BroadcastReceiver.PendingResult beginRead(Notification notice) throws Exception {
    Receiver receiver = new Receiver();
    Object pending = org.robolectric.util.ReflectionHelpers.callConstructor(BroadcastReceiver.PendingResult.class,
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(int.class, 0),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(String.class, null),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(android.os.Bundle.class, null),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(int.class, 2),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(boolean.class, false),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(boolean.class, false),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(android.os.IBinder.class, null),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(int.class, 0),
        org.robolectric.util.ReflectionHelpers.ClassParameter.from(int.class, 0));
    org.robolectric.util.ReflectionHelpers.callInstanceMethod(receiver, "setPendingResult", org.robolectric.util.ReflectionHelpers.ClassParameter.from(BroadcastReceiver.PendingResult.class, (BroadcastReceiver.PendingResult) pending));
    receiver.onReceive(context, Shadows.shadowOf(notice.actions[1].actionIntent).getSavedIntent());
    return (BroadcastReceiver.PendingResult) pending;
  }
  private void finishRead(BroadcastReceiver.PendingResult pending) throws Exception {
    SmsTelephony.WORK.submit(() -> {}).get(10, java.util.concurrent.TimeUnit.SECONDS);
    assertSame("receiver always releases its broadcast owner", pending,
        Shadows.shadowOf(pending).getFuture().get(10, java.util.concurrent.TimeUnit.SECONDS));
  }
  private void deliverRead(Notification notice) throws Exception { finishRead(beginRead(notice)); }
  @Test public void markReadChangesOnlyReceivedRowsInTheShownThreadThroughItsCutoff() throws Exception {
    Notification notice = post(1, 7, "Shown message");
    long cutoff = Shadows.shadowOf(notice.actions[1].actionIntent).getSavedIntent().getLongExtra(MmsResultReceiver.EXTRA_THROUGH, 0);
    unread("sms", 1, 7, SmsRecords.INBOX, cutoff);
    unread("sms", 2, 7, SmsRecords.INBOX, cutoff + 1);
    unread("sms", 3, 8, SmsRecords.INBOX, cutoff - 1);
    unread("sms", 4, 7, SmsSendJournal.TYPE_SENT, cutoff - 1);
    long seconds = SmsRecords.mmsSecondsThrough(cutoff);
    unread("mms", 1, 7, SmsRecords.INBOX, seconds);
    unread("mms", 2, 7, SmsRecords.INBOX, seconds + 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName());
    deliverRead(notice);
    assertEquals(1, read("sms", 1)); assertEquals(0, read("sms", 2));
    assertEquals(0, read("sms", 3)); assertEquals(0, read("sms", 4));
    assertEquals(1, read("mms", 1)); assertEquals(0, read("mms", 2));
    assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
  }
  @Test public void lostSmsRoleDismissesTheNoticeWithoutAProviderWrite() throws Exception {
    Notification notice = post(1, 7, "Shown message"); unread("sms", 1, 7, SmsRecords.INBOX, 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage("another.owner");
    deliverRead(notice); assertEquals(0, Provider.writes); assertEquals(0, read("sms", 1));
    assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
  }
  @Test public void failedProviderWriteKeepsTheNoticeAndFinishesTheReceiver() throws Exception {
    Notification notice = post(1, 7, "Shown message"); unread("sms", 1, 7, SmsRecords.INBOX, 1); unread("mms", 1, 7, SmsRecords.INBOX, 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName()); Provider.failMms = true;
    deliverRead(notice);
    assertEquals("the first provider effect is retained, not misrepresented as atomic", 1, read("sms", 1));
    assertEquals(0, read("mms", 1));
    assertEquals(1, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    assertFalse("a failed effect keeps the same action available for retry", Shadows.shadowOf(notice.actions[1].actionIntent).isCanceled());
    Provider.failMms = false; deliverRead(notice);
    assertEquals(1, read("mms", 1));
    assertEquals(0, context.getSystemService(NotificationManager.class).getActiveNotifications().length);
    assertTrue("successful read retires its action", Shadows.shadowOf(notice.actions[1].actionIntent).isCanceled());
  }
  @Test public void oldQueuedReadCannotConsumeANewerConversationNotice() throws Exception {
    Notification shown = post(1, 7, "Shown message"); unread("sms", 1, 7, SmsRecords.INBOX, 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName());
    java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1), release = new java.util.concurrent.CountDownLatch(1);
    SmsTelephony.WORK.execute(() -> { entered.countDown(); try { if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("Worker was not released"); } catch (InterruptedException stopped) { Thread.currentThread().interrupt(); } });
    assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
    try {
      // Valid owner order: the incoming work was queued before the user taps the old notice.
      SmsTelephony.WORK.execute(() -> { unread("sms", 2, 7, SmsRecords.INBOX, 1); post(2, 7, "New unread message with an older sender timestamp"); });
      BroadcastReceiver.PendingResult pending = beginRead(shown);
      release.countDown(); finishRead(pending);
      assertEquals("a stale notice grants no new read effect", 0, read("sms", 2));
      android.service.notification.StatusBarNotification[] notices = context.getSystemService(NotificationManager.class).getActiveNotifications();
      assertEquals("the replacement unread notice stays visible", 1, notices.length);
      assertEquals("New unread message with an older sender timestamp", notices[0].getNotification().extras.getCharSequence(Notification.EXTRA_TEXT));
    } finally { release.countDown(); SmsTelephony.WORK.submit(() -> {}).get(10, java.util.concurrent.TimeUnit.SECONDS); }
  }
  @Test public void delayedPublicationRetainsHistoryAndFencesTheOldReadBeforeAcknowledgement() throws Exception {
    Notification previous = post(1, 7, "First full text"); unread("sms", 1, 7, SmsRecords.INBOX, 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName());
    DelayedNotifications.hold = true;
    java.util.concurrent.Future<Notification> posted = SmsTelephony.WORK.submit(() -> post(2, 7, "Second full text"));
    assertTrue(DelayedNotifications.queued.await(10, java.util.concurrent.TimeUnit.SECONDS));
    BroadcastReceiver.PendingResult oldRead = beginRead(previous);
    try {
      assertFalse("enqueue is not a native publication receipt", posted.isDone());
      assertTrue("prior action is retired before publication", Shadows.shadowOf(previous.actions[1].actionIntent).isCanceled());
      ((DelayedNotifications) Shadows.shadowOf(context.getSystemService(NotificationManager.class))).publish();
      Notification current = posted.get(10, java.util.concurrent.TimeUnit.SECONDS);
      java.util.List<Notification.MessagingStyle.Message> texts = Notification.MessagingStyle.Message.getMessagesFromBundleArray(current.extras.getParcelableArray(Notification.EXTRA_MESSAGES));
      assertEquals(2, texts.size()); assertEquals("First full text", texts.get(0).getText());
      assertEquals("Second full text", texts.get(1).getText());
      finishRead(oldRead); assertEquals("the queued old action grants no provider writes", 0, Provider.writes);
      assertEquals(0, read("sms", 1));
    } finally {
      if (DelayedNotifications.hold) ((DelayedNotifications) Shadows.shadowOf(context.getSystemService(NotificationManager.class))).publish();
      posted.get(10, java.util.concurrent.TimeUnit.SECONDS);
    }
  }
  @Test public void interruptedPublicationRetiresItsActionEvenIfAndroidPublishesLate() throws Exception {
    post(1, 7, "First full text");
    DelayedNotifications.hold = true;
    java.util.concurrent.Future<?> posted = SmsTelephony.WORK.submit(() -> {
      Thread.currentThread().interrupt();
      try { assertThrows(IllegalStateException.class, () -> post(2, 7, "Unconfirmed replacement")); }
      finally { Thread.interrupted(); }
    });
    posted.get(10, java.util.concurrent.TimeUnit.SECONDS);
    assertTrue(DelayedNotifications.queued.await(10, java.util.concurrent.TimeUnit.SECONDS));
    Notification late = DelayedNotifications.pending;
    ((DelayedNotifications) Shadows.shadowOf(context.getSystemService(NotificationManager.class))).publish();
    assertTrue(Shadows.shadowOf(late.actions[1].actionIntent).isCanceled());
    unread("sms", 1, 7, SmsRecords.INBOX, 1);
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName());
    deliverRead(late);
    assertEquals("a late unconfirmed notice has no live action authority", 0, Provider.writes);
    assertEquals(0, read("sms", 1));
  }
  @Test public void publicationDeadlinePreservesStoredRowsAndRetiresUnconfirmedActions() throws Exception {
    Notification previous = post(1, 7, "First full text");
    unread("sms", 1, 7, SmsRecords.INBOX, 1); unread("mms", 1, 7, SmsRecords.INBOX, 1);
    DelayedNotifications.hold = true;
    try {
      assertThrows(IllegalStateException.class, () -> post(2, 7, "Unconfirmed replacement"));
      assertTrue(Shadows.shadowOf(previous.actions[1].actionIntent).isCanceled());
      assertTrue(Shadows.shadowOf(DelayedNotifications.pending.actions[1].actionIntent).isCanceled());
      assertEquals(0, Provider.writes); assertEquals(0, read("sms", 1)); assertEquals(0, read("mms", 1));
    } finally { ((DelayedNotifications) Shadows.shadowOf(context.getSystemService(NotificationManager.class))).publish(); }
    org.robolectric.shadows.ShadowTelephony.ShadowSms.setDefaultSmsPackage(context.getPackageName());
    deliverRead(DelayedNotifications.pending);
    assertEquals("a timed-out enqueue is not restored by late publication", 0, Provider.writes);
  }
}

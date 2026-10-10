package example.mirror;

import static org.junit.Assert.*;

import ai.eliza.plugins.notifications.NoticeDelivery;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;

/** Real durable receipts and NotificationManager effects, using only synthetic fixture data. */
public final class NoticeDeliveryTest {
  interface Work { void run() throws Exception; }
  private static void rejects(Work work) throws Exception {
    try { work.run(); } catch (IllegalStateException expected) { return; }
    fail("Changed receipt must be refused");
  }

  @Test public void durableReceiptsNeverRepeatNotificationEffects() throws Exception {
    assertEquals("1", InstrumentationRegistry.getArguments().getString("disposableMirrorFixture"));
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String name = "notice-receipts-" + UUID.randomUUID();
    SharedPreferences preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    manager.createNotificationChannel(new NotificationChannel(name, "Synthetic receipts", NotificationManager.IMPORTANCE_LOW));
    NoticeDelivery.Config config = new NoticeDelivery.Config("steps", "approvals", "Synthetic approval", "Review synthetic fixture", 600000);
    int[] posts = {0};
    NoticeDelivery.Storage storage = new NoticeDelivery.Storage() {
      public String read(String slot) { return preferences.getString(slot, null); }
      public void write(String slot, String value) {
        if (!preferences.edit().putString(slot, value).commit()) throw new IllegalStateException("Receipt write failed");
      }
    };
    NoticeDelivery.Poster poster = new NoticeDelivery.Poster() {
      public boolean allowed() { return manager.areNotificationsEnabled(); }
      public void post(String id, String title, String body) { postApproval(id, title, body, 60000); }
      public void postApproval(String id, String title, String body, long timeout) {
        posts[0]++;
        manager.notify(id, 1, new Notification.Builder(context, name)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title)
            .setContentText(body).setTimeoutAfter(timeout).build());
      }
      public boolean matches(String id, String title, String body) {
        long deadline = SystemClock.elapsedRealtime() + 3000;
        do {
          for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
            if (id.equals(notification.getTag()) && title.equals(notification.getNotification().extras.getString(Notification.EXTRA_TITLE))
                && body.equals(notification.getNotification().extras.getString(Notification.EXTRA_TEXT))) return true;
          }
          SystemClock.sleep(25);
        } while (SystemClock.elapsedRealtime() < deadline);
        return false;
      }
      public void cancel(String id) { manager.cancel(id, 1); }
    };
    String binding = "a".repeat(64), approval = "approval-" + "b".repeat(64);
    try {
      assertTrue("Fixture needs POST_NOTIFICATIONS", poster.allowed());
      NoticeDelivery delivery = new NoticeDelivery(config, storage, poster);
      assertEquals("succeeded", delivery.publish("step", binding, "Synthetic step", "Synthetic body"));
      assertEquals(1, posts[0]);
      manager.cancel("step", 1);
      assertEquals("succeeded", new NoticeDelivery(config, storage, poster).publish("step", binding, "Synthetic step", "Synthetic body"));
      assertEquals("Dismissed notification must not post again", 1, posts[0]);
      rejects(() -> delivery.publish("step", binding, "Changed title", "Synthetic body"));
      long now = System.currentTimeMillis(), expiry = now + 60000;
      assertEquals("succeeded", delivery.publishApproval(approval, binding, expiry, now));
      assertEquals(2, posts[0]);
      String original = storage.read("approvals");
      JSONObject damaged = new JSONObject(original);
      damaged.getJSONObject(approval).put("digest", "0".repeat(64));
      storage.write("approvals", damaged.toString());
      rejects(() -> new NoticeDelivery(config, storage, poster).publishApproval(approval, binding, expiry, now));
      assertEquals(2, posts[0]);
      storage.write("approvals", original);
      delivery.withdrawApproval(approval);
      assertEquals("withdrawn", new NoticeDelivery(config, storage, poster).publishApproval(approval, binding, expiry, now));
      assertEquals(2, posts[0]);
      assertEquals(java.util.List.of(approval), delivery.expireApprovals(expiry));
      assertEquals("expired", delivery.publishApproval(approval, binding, expiry, expiry));
      assertFalse(storage.read("steps").contains("Synthetic"));
      assertEquals(2, posts[0]);
    } finally {
      manager.cancel("step", 1);
      manager.cancel(approval, 1);
      manager.deleteNotificationChannel(name);
      context.deleteSharedPreferences(name);
    }
  }
}

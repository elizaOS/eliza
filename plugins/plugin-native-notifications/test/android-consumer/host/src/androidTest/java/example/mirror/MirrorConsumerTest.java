package example.mirror;
import static org.junit.Assert.*;

import ai.eliza.plugins.notifications.NotificationMirror;
import android.content.*;
import android.os.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.json.*;
import org.junit.Test;

/** Real Android listener, two synthetic app UIDs, and Android Keystore history. */
public final class MirrorConsumerTest {
  private static final String SELECTED = "example.notificationmirror.selected",
                              EXCLUDED = "example.notificationmirror.excluded";
  private final Context c = InstrumentationRegistry.getInstrumentation().getTargetContext();
  private final NotificationMirror mirror = TestListener.MIRROR;
  private void await(Callable<Boolean> check, String label) throws Exception {
    long until = SystemClock.elapsedRealtime() + 20000;
    do {
      if (check.call())
        return;
      SystemClock.sleep(100);
    } while (SystemClock.elapsedRealtime() < until);
    fail(label);
  }
  private void shell(String command) throws Exception {
    try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(
             InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(
                 command))) {
      in.readAllBytes();
    }
  }
  private void post(String pkg, String nonce, String operation) throws Exception {
    java.util.concurrent.CountDownLatch delivered = new java.util.concurrent.CountDownLatch(1);
    c.sendOrderedBroadcast(new Intent()
                               .setClassName(pkg, "example.mirrorfixture.PostReceiver")
                               .addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
                               .putExtra("nonce", nonce)
                               .putExtra("operation", operation),
        null, new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            delivered.countDown();
          }
        }, new Handler(Looper.getMainLooper()), 0, null, null);
    assertTrue(
        "Synthetic producer completed", delivered.await(20, java.util.concurrent.TimeUnit.SECONDS));
  }
  private void policy(boolean preview, boolean history) throws Exception {
    mirror.update(c,
        new JSONObject()
            .put("expectedRevision", mirror.status(c).getString("revision"))
            .put("enabled", true)
            .put("history", history)
            .put("apps",
                new JSONArray().put(
                    new JSONObject().put("packageName", SELECTED).put("preview", preview))));
  }
  @Test
  public void selectedNoticesRedactionStaleActionsEncryptedHistoryAndRevocation() throws Exception {
    assertEquals("Fixture runner must use a disposable user", "1",
        InstrumentationRegistry.getArguments().getString("disposableMirrorFixture"));
    assertFalse(mirror.granted(c));
    assertNotEquals(
        c.getApplicationInfo().uid, c.getPackageManager().getApplicationInfo(SELECTED, 0).uid);
    String nonce = UUID.randomUUID().toString(), excluded = UUID.randomUUID().toString();
    String component = mirror.component(c).flattenToString();
    File encrypted = new File(c.getNoBackupFilesDir(), mirror.config().historyFileName);
    try {
      shell("cmd notification allow_listener " + component);
      await(() -> mirror.granted(c), "Android grant");
      policy(false, false);
      await(() -> mirror.listener() != null, "Real connected listener");
      post(SELECTED, nonce, "post");
      post(EXCLUDED, excluded, "post");
      await(() -> mirror.list(c).length() == 2, "Only selected app notices");
      assertFalse(mirror.list(c).toString().contains(nonce));
      JSONObject old = mirror.list(c).getJSONObject(0);
      policy(true, true);
      try {
        mirror.action(c, old.getString("id"), old.getString("revision"), false);
        fail("Stale row admitted");
      } catch (IllegalStateException expected) {
      }
      post(SELECTED, nonce, "post");
      await(() -> mirror.history(c).length() > 0, "Actual post history");
      JSONArray rows = mirror.list(c);
      assertEquals(2, rows.length());
      int hidden = 0, shown = 0;
      for (int i = 0; i < rows.length(); i++) {
        JSONObject row = rows.getJSONObject(i);
        if (row.getBoolean("redacted"))
          hidden++;
        else {
          shown++;
          assertTrue(row.getString("text").contains(nonce));
        }
      }
      assertEquals(1, hidden);
      assertEquals(1, shown);
      assertFalse(rows.toString().contains(excluded));
      assertTrue(encrypted.isFile());
      String raw = new String(Files.readAllBytes(encrypted.toPath()), StandardCharsets.ISO_8859_1);
      assertFalse(raw.contains("Synthetic"));
      assertFalse(raw.contains(nonce));
      assertFalse(raw.contains(SELECTED));
      assertFalse(mirror.history(c).toString().contains(nonce));
      JSONObject row = mirror.list(c).getJSONObject(0);
      mirror.action(c, row.getString("id"), row.getString("revision"), false);
      await(() -> mirror.list(c).length() == 1, "Actual Android dismissal");
      await(() -> {
        JSONArray history = mirror.history(c);
        for (int i = 0; i < history.length(); i++)
          if ("Removed".equals(history.getJSONObject(i).getString("state")))
            return true;
        return false;
      }, "Actual removal callback recorded");
      mirror.clearHistoryBoundary(c);
      assertEquals(0, mirror.history(c).length());
      mirror.pause(c, true);
      assertEquals(0, mirror.list(c).length());
      assertFalse(encrypted.exists());
      shell("cmd notification disallow_listener " + component);
      await(() -> !mirror.granted(c), "Android grant revoked");
      assertEquals(0, mirror.list(c).length());
    } finally {
      post(SELECTED, nonce, "clear");
      post(EXCLUDED, excluded, "clear");
      mirror.pause(c, true);
      shell("cmd notification disallow_listener " + component);
      mirror.clearHistoryBoundary(c);
    }
  }
}

// spec/os/android/notificationMirror.md, "A failed deletion is never reported as cleared and blocks history until a deletion succeeds"
package ai.eliza.plugins.notifications;

import android.app.Notification;
import android.content.Context;
import android.service.notification.StatusBarNotification;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

public final class NotificationHistoryContract {
  private static final String SELECTED = "com.android.settings";
  private static final String OLD_RECORD = "fixtureOldHistoryId";

  private NotificationHistoryContract() {}

  public static void configure(Context host, NotificationMirror mirror) throws Exception {
    if (mirror.prefs(host).contains("policy"))
      return;
    JSONObject app = new JSONObject().put("packageName", SELECTED)
        .put("signature", NotificationMirror.signature(host, SELECTED)).put("label", "Settings");
    JSONObject policy = new JSONObject().put("revision", "fixture-1").put("enabled", true)
        .put("history", true).put("apps", new JSONArray().put(app));
    check(mirror.prefs(host).edit().putString("policy", policy.toString()).commit(), "Fixture policy was not durable");
  }

  public static void leaveCleanupPending(Context host, NotificationMirror mirror,
      NotificationMirrorListenerService listener) throws Exception {
    check(mirror.granted(host), "Listener access must be granted");
    observed(host, mirror, listener, 1, mirror.eventGeneration());
    JSONArray old = mirror.history(host);
    check(old.length() == 1, "Expected the existing encrypted history");
    check(mirror.prefs(host).edit().putString(OLD_RECORD, old.getJSONObject(0).getString("id")).commit(),
        "Fixture record was not durable");

    String revision = mirror.status(host).getString("revision");
    File base = base(host, mirror);
    File retained = retained(host, mirror);
    byte[] ciphertext = Files.readAllBytes(base.toPath());
    long admitted = mirror.eventGeneration();
    try {
      mirror.clearHistoryBoundary(host, revision + "-stale");
      throw new AssertionError("Clear accepted a stale policy revision");
    } catch (IllegalStateException stale) {
      check(mirror.eventGeneration() == admitted && Arrays.equals(ciphertext, Files.readAllBytes(base.toPath())),
          "A stale clear changed the current encrypted history");
    }
    Files.createDirectory(retained.getParentFile().toPath());
    Files.write(retained.toPath(), ciphertext);
    long before = mirror.eventGeneration();
    try {
      mirror.clearHistoryBoundary(host, revision);
      throw new AssertionError("Clear acknowledged an undeleted AtomicFile sidecar");
    } catch (IllegalStateException pending) {
      check(mirror.eventGeneration() != before, "Clear did not invalidate queued callbacks");
    }

    Files.write(base.toPath(), ciphertext);
    assertWithheld(host, mirror, listener, ciphertext);
    check(mirror.status(host).getBoolean("historyUnavailable"), "Status did not report the failed retry");
  }

  public static void finishAfterRestart(Context host, NotificationMirror mirror,
      NotificationMirrorListenerService listener) throws Exception {
    check(mirror.granted(host), "Listener access must survive the fixture restart");
    File base = base(host, mirror);
    File retained = retained(host, mirror);
    byte[] ciphertext = Files.readAllBytes(retained.toPath());
    Files.write(base.toPath(), ciphertext);
    assertWithheld(host, mirror, listener, ciphertext);
    check(mirror.status(host).getBoolean("historyUnavailable"), "The persisted cleanup obligation was lost");

    Files.delete(retained.toPath());
    Files.delete(retained.getParentFile().toPath());
    Files.write(base.toPath(), ciphertext);
    assertWithheld(host, mirror, listener, ciphertext);
    JSONObject status = mirror.status(host);
    check(status.getBoolean("history") && !status.getBoolean("historyUnavailable"),
        "A successful retry did not restore the original history consent");
    check(!base.exists() && !retained.getParentFile().exists()
        && !new File(base.getPath() + ".bak").exists(), "History artifacts survived a successful retry");
    check(mirror.history(host).length() == 0, "Recovery restored old history");

    observed(host, mirror, listener, 3, mirror.eventGeneration());
    JSONArray fresh = mirror.history(host);
    check(fresh.length() == 1, "Fresh history did not resume");
    check(!fresh.getJSONObject(0).getString("id").equals(mirror.prefs(host).getString(OLD_RECORD, "")),
        "A pre-clear record returned");
  }

  private static void assertWithheld(Context host, NotificationMirror mirror,
      NotificationMirrorListenerService listener, byte[] ciphertext) throws Exception {
    check(mirror.history(host).length() == 0, "Old history escaped while cleanup was pending");
    observed(host, mirror, listener, 2, mirror.eventGeneration());
    check(Arrays.equals(ciphertext, Files.readAllBytes(base(host, mirror).toPath())),
        "A callback wrote history while cleanup was pending");
  }

  private static void observed(Context host, NotificationMirror mirror,
      NotificationMirrorListenerService listener, int id, long generation) throws Exception {
    int uid = host.getPackageManager().getApplicationInfo(SELECTED, 0).uid;
    StatusBarNotification notice = new StatusBarNotification(SELECTED, SELECTED, id, null, uid, 0, 0,
        new Notification(), android.os.Process.myUserHandle(), System.currentTimeMillis());
    mirror.changed(listener, notice, false, generation);
  }

  private static File base(Context host, NotificationMirror mirror) {
    return new File(host.getNoBackupFilesDir(), mirror.config().historyFileName);
  }

  private static File retained(Context host, NotificationMirror mirror) {
    return new File(new File(base(host, mirror).getPath() + ".new"), "retained");
  }

  private static void check(boolean ok, String message) {
    if (!ok)
      throw new AssertionError(message);
  }
}

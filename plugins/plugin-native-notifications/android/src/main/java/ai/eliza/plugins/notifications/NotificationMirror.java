package ai.eliza.plugins.notifications;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.os.PowerManager;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Opt-in mirror of other apps' active notifications for one host. Android grants listener access;
 * the owner separately enables the mirror, selects at most 20 launcher apps (pinned by signing
 * certificate) and may opt into a 24-hour encrypted history of post/remove events. No notification
 * text, PendingIntent or foreign key is persisted, and nothing here forwards data off the device.
 * Rows carry opaque per-process ids and revisions; a locked device, a new policy or a screen-off
 * redaction invalidates them.
 */
public final class NotificationMirror {
  public final Object lock = new Object();
  private final NotificationMirrorConfig config;
  private final Map<String, Entry> entries = new LinkedHashMap<>();
  private final Set<String> historyFailures = new HashSet<>();
  private volatile long generation;
  private NotificationMirrorListenerService listener;
  private static final class Entry {
    final String key, id = UUID.randomUUID().toString(), revision = UUID.randomUUID().toString();
    final long at;
    Entry(StatusBarNotification n) {
      key = n.getKey();
      at = n.getPostTime();
    }
  }
  public NotificationMirror(NotificationMirrorConfig config) {
    if (config == null)
      throw new IllegalArgumentException("Notification mirror configuration is required");
    this.config = config;
  }
  public NotificationMirrorConfig config() {
    return config;
  }
  public ComponentName component(Context c) {
    return new ComponentName(c, config.listener);
  }
  public SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(config.preferencesName, Context.MODE_PRIVATE);
  }
  public boolean granted(Context c) {
    return c.getSystemService(NotificationManager.class)
        .isNotificationListenerAccessGranted(component(c));
  }
  /** The connected listener, or null. */
  public NotificationMirrorListenerService listener() {
    synchronized (lock) {
      return listener;
    }
  }
  public long eventGeneration() {
    return generation;
  }
  private JSONObject policy(Context c) throws Exception {
    return new JSONObject(prefs(c).getString("policy", NotificationMirrorPolicy.INITIAL_POLICY));
  }
  private boolean paused(Context c) {
    return prefs(c).getBoolean("paused", false);
  }
  private boolean active(Context c, JSONObject p) {
    return NotificationMirrorPolicy.active(p.optBoolean("enabled"), paused(c), granted(c));
  }
  private void invalidate() {
    generation++;
    entries.clear();
  }
  private static boolean locked(Context c) {
    return c.getSystemService(KeyguardManager.class).isDeviceLocked()
        || !c.getSystemService(PowerManager.class).isInteractive();
  }
  /** SHA-256 over the package's current signing certificates. */
  public static String signature(Context c, String name) throws Exception {
    PackageInfo info =
        c.getPackageManager().getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES);
    if (info.signingInfo == null)
      throw new IllegalStateException();
    java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
    for (Signature cert : info.signingInfo.getApkContentsSigners())
      digest.update(cert.toByteArray());
    return android.util.Base64.encodeToString(digest.digest(), android.util.Base64.NO_WRAP);
  }
  private static boolean validSignature(Context c, JSONObject app) {
    try {
      return app.getString("signature").equals(signature(c, app.getString("packageName")));
    } catch (Exception missing) {
      return false;
    }
  }
  /** Launcher apps the owner may choose from, excluding the host itself. */
  public JSONArray apps(Context c) throws Exception {
    JSONArray out = new JSONArray();
    Set<String> seen = new HashSet<>();
    PackageManager pm = c.getPackageManager();
    for (ResolveInfo r : pm.queryIntentActivities(
             new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
      if (r == null || r.activityInfo == null || !r.activityInfo.enabled || !r.activityInfo.exported
          || r.activityInfo.applicationInfo == null || !r.activityInfo.applicationInfo.enabled
          || r.activityInfo.packageName == null)
        continue;
      String pkg = r.activityInfo.packageName;
      if (pkg.equals(c.getPackageName()) || !seen.add(pkg))
        continue;
      out.put(new JSONObject()
              .put("packageName", pkg)
              .put("label",
                  NotificationMirrorPolicy.bounded(
                      r.loadLabel(pm), NotificationMirrorPolicy.LABEL_LIMIT)));
    }
    return out;
  }
  private JSONObject allowed(Context c, JSONObject p, StatusBarNotification n) throws Exception {
    boolean sameUser = n.getUser().equals(android.os.Process.myUserHandle()),
            own = n.getPackageName().equals(c.getPackageName()), uid;
    try {
      uid = c.getPackageManager().getApplicationInfo(n.getPackageName(), 0).uid == n.getUid();
    } catch (PackageManager.NameNotFoundException missing) {
      return null;
    }
    if (!sameUser || own || !uid)
      return null;
    JSONArray apps = p.getJSONArray("apps");
    for (int i = 0; i < apps.length(); i++) {
      JSONObject a = apps.getJSONObject(i);
      if (a.getString("packageName").equals(n.getPackageName())
          && NotificationMirrorPolicy.admits(sameUser, own, uid, validSignature(c, a)))
        return a;
    }
    return null;
  }
  public JSONObject status(Context c) throws Exception {
    synchronized (lock) {
      JSONObject p = policy(c);
      if (!granted(c)) {
        invalidate();
        clearHistory(c);
      }
      try {
        pruneHistory(c, p);
      } catch (Exception unavailable) {
        historyFailures.add(c.getPackageName());
      }
      JSONObject out = new JSONObject();
      out.put("revision", p.getString("revision"));
      out.put("enabled", p.optBoolean("enabled"));
      out.put("accessGranted", granted(c));
      out.put("connected", listener != null);
      out.put("paused", paused(c));
      out.put("history", p.optBoolean("history"));
      out.put("historyUnavailable", historyFailures.contains(c.getPackageName()));
      JSONArray selected = new JSONArray(), stored = p.getJSONArray("apps");
      for (int i = 0; i < stored.length(); i++) {
        JSONObject a = stored.getJSONObject(i);
        selected.put(new JSONObject()
                .put("packageName", a.getString("packageName"))
                .put("label", a.getString("label"))
                .put("preview", a.optBoolean("preview"))
                .put("available", validSignature(c, a)));
      }
      out.put("apps", selected);
      return out;
    }
  }
  /** Applies an owner policy change guarded by the revision the owner reviewed. */
  public JSONObject update(Context c, JSONObject input) throws Exception {
    synchronized (lock) {
      JSONObject p = policy(c);
      if (!p.getString("revision").equals(input.getString("expectedRevision")))
        throw new IllegalStateException("Notification settings changed. Refresh Settings.");
      if (input.has("apps")) {
        JSONArray next = input.getJSONArray("apps"), previous = p.getJSONArray("apps"),
                  valid = new JSONArray();
        List<String> requested = new ArrayList<>();
        Set<String> visible = new HashSet<>();
        Map<String, Boolean> prior = new HashMap<>();
        if (next.length() > NotificationMirrorPolicy.MAX_SELECTED_APPS)
          throw new NotificationMirrorPolicy.Rejected(
              "Choose at most " + NotificationMirrorPolicy.MAX_SELECTED_APPS + " apps");
        JSONArray choices = apps(c);
        for (int i = 0; i < choices.length(); i++)
          visible.add(choices.getJSONObject(i).getString("packageName"));
        for (int i = 0; i < previous.length(); i++) {
          JSONObject a = previous.getJSONObject(i);
          prior.put(a.getString("packageName"), validSignature(c, a));
        }
        for (int i = 0; i < next.length(); i++)
          requested.add(next.getJSONObject(i).getString("packageName"));
        NotificationMirrorPolicy.checkSelection(requested, visible, prior);
        for (int i = 0; i < next.length(); i++) {
          JSONObject a = next.getJSONObject(i);
          String name = a.getString("packageName");
          PackageManager pm = c.getPackageManager();
          valid.put(new JSONObject()
                  .put("packageName", name)
                  .put("signature", signature(c, name))
                  .put("label",
                      NotificationMirrorPolicy.bounded(
                          pm.getApplicationLabel(pm.getApplicationInfo(name, 0)),
                          NotificationMirrorPolicy.LABEL_LIMIT))
                  .put("preview", a.optBoolean("preview", false)));
        }
        p.put("apps", valid);
      }
      if (input.has("enabled"))
        p.put("enabled", input.getBoolean("enabled"));
      if (input.has("history"))
        p.put("history", input.getBoolean("history"));
      p.put("revision", UUID.randomUUID().toString());
      // Purge before acknowledging a new policy, including queued callback revisions.
      invalidate();
      clearHistory(c);
      if (!prefs(c).edit().putString("policy", p.toString()).commit())
        throw new IOException();
      if (!p.optBoolean("enabled") && listener != null)
        listener.requestUnbind();
      else if (active(c, p))
        NotificationListenerService.requestRebind(component(c));
      return status(c);
    }
  }
  public void pause(Context c, boolean paused) throws Exception {
    synchronized (lock) {
      invalidate();
      if (!prefs(c).edit().putBoolean("paused", paused).commit())
        throw new IOException();
      if (paused) {
        clearHistory(c);
        if (listener != null)
          listener.requestUnbind();
      } else if (active(c, policy(c)))
        NotificationListenerService.requestRebind(component(c));
    }
  }
  void connected(NotificationMirrorListenerService service) {
    synchronized (lock) {
      listener = service;
      generation++;
      entries.clear();
      try {
        JSONObject p = policy(service);
        if (!active(service, p)) {
          if (!granted(service))
            clearHistory(service);
          return;
        }
        pruneHistory(service, p);
      } catch (Exception failure) {
        historyFailures.add(service.getPackageName());
      }
    }
  }
  void disconnected(NotificationMirrorListenerService service) {
    synchronized (lock) {
      if (listener != service)
        return;
      listener = null;
      invalidate();
      if (!granted(service))
        clearHistory(service);
    }
  }
  void invalidateKey(String key) {
    synchronized (lock) {
      entries.remove(key);
    }
  }
  /**
   * Drops every opaque row identity, for example on screen off, host pause or a full event queue.
   */
  public void redact() {
    synchronized (lock) {
      invalidate();
    }
  }
  void changed(NotificationMirrorListenerService service, StatusBarNotification n, boolean removed,
      long observed) {
    synchronized (lock) {
      if (observed != generation || listener != service)
        return;
      entries.remove(n.getKey());
      try {
        JSONObject p = policy(service);
        if (!active(service, p)) {
          entries.clear();
          if (!granted(service))
            clearHistory(service);
          return;
        }
        JSONObject app = allowed(service, p, n);
        if (app == null)
          return;
        if (!removed && !locked(service))
          entries.put(n.getKey(), new Entry(n));
        trim();
        if (p.optBoolean("history")) {
          try {
            recordEvent(service, app, n.getPostTime(), removed ? "Removed" : "Posted");
          } catch (Exception failure) {
            historyFailures.add(service.getPackageName());
            throw failure;
          }
        }
      } catch (Exception failure) {
        entries.clear();
      }
    }
  }
  private void trim() {
    while (entries.size() > NotificationMirrorPolicy.MAX_ACTIVE)
      entries.remove(entries.keySet().iterator().next());
  }
  /**
   * Active selected-app notifications, newest first, bounded and redacted per the owner's preview
   * choice.
   */
  public JSONArray list(Context c) throws Exception {
    synchronized (lock) {
      JSONArray out = new JSONArray();
      JSONObject p = policy(c);
      if (!active(c, p) || listener == null || locked(c)) {
        entries.clear();
        if (!granted(c))
          clearHistory(c);
        return out;
      }
      StatusBarNotification[] current = listener.getActiveNotifications();
      if (current == null)
        throw new IllegalStateException();
      Arrays.sort(current, Comparator.comparingLong(StatusBarNotification::getPostTime).reversed());
      Set<String> live = new HashSet<>();
      for (StatusBarNotification n : current) {
        JSONObject app = allowed(c, p, n);
        if (app == null)
          continue;
        live.add(n.getKey());
        if (out.length() >= NotificationMirrorPolicy.MAX_ACTIVE) {
          invalidate();
          throw new NotificationMirrorPolicy.Rejected(
              "Too many active notifications; select fewer apps");
        }
        Entry e = entries.get(n.getKey());
        if (e == null || e.at != n.getPostTime()) {
          e = new Entry(n);
          entries.put(n.getKey(), e);
        }
        Notification notice = n.getNotification();
        boolean secret = notice.visibility == Notification.VISIBILITY_SECRET,
                hidden = NotificationMirrorPolicy.hidden(app.optBoolean("preview"), secret);
        JSONObject row = new JSONObject();
        row.put("id", e.id);
        row.put("revision", e.revision);
        row.put("source", "external");
        row.put("appLabel", app.getString("label"));
        row.put("title",
            hidden ? app.getString("label")
                   : NotificationMirrorPolicy.bounded(notice.extras == null
                             ? null
                             : notice.extras.getCharSequence(Notification.EXTRA_TITLE),
                         NotificationMirrorPolicy.TITLE_LIMIT));
        row.put("text",
            hidden ? "Content hidden"
                   : NotificationMirrorPolicy.bounded(notice.extras == null
                             ? null
                             : notice.extras.getCharSequence(Notification.EXTRA_BIG_TEXT,
                                   notice.extras.getCharSequence(Notification.EXTRA_TEXT)),
                         NotificationMirrorPolicy.TEXT_LIMIT));
        row.put("redacted", hidden);
        row.put("at", n.getPostTime());
        row.put("clearable", n.isClearable());
        row.put("canOpen",
            NotificationMirrorPolicy.canOpen(secret, notice.contentIntent != null,
                notice.contentIntent == null ? -1 : notice.contentIntent.getCreatorUid(),
                n.getUid()));
        out.put(row);
      }
      entries.keySet().retainAll(live);
      trim();
      return out;
    }
  }
  /** Opens (runs the posting app's own content intent) or dismisses the exact current row. */
  public void action(Context c, String id, String revision, boolean open) throws Exception {
    synchronized (lock) {
      JSONObject p = policy(c);
      if (!active(c, p) || listener == null || locked(c))
        throw new IllegalStateException();
      Entry e = null;
      for (Entry item : entries.values())
        if (item.id.equals(id) && item.revision.equals(revision))
          e = item;
      if (e == null)
        throw new IllegalStateException();
      StatusBarNotification found = null;
      StatusBarNotification[] rows = listener.getActiveNotifications(new String[] {e.key});
      if (rows != null)
        for (StatusBarNotification n : rows)
          if (n.getPostTime() == e.at && allowed(c, p, n) != null)
            found = n;
      if (found == null)
        throw new IllegalStateException();
      Notification n = found.getNotification();
      if (open) {
        if (!NotificationMirrorPolicy.canOpen(n.visibility == Notification.VISIBILITY_SECRET,
                n.contentIntent != null,
                n.contentIntent == null ? -1 : n.contentIntent.getCreatorUid(), found.getUid()))
          throw new IllegalStateException();
        n.contentIntent.send();
        if ((n.flags & Notification.FLAG_AUTO_CANCEL) != 0)
          listener.cancelNotification(found.getKey());
      } else {
        if (!found.isClearable())
          throw new IllegalStateException();
        listener.cancelNotification(found.getKey());
      }
    }
  }
  private AtomicFile historyFile(Context c) {
    return new AtomicFile(new File(c.getNoBackupFilesDir(), config.historyFileName));
  }
  private SecretKey key() throws Exception {
    java.security.KeyStore store = java.security.KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    String alias = config.historyKeyAlias;
    if (!store.containsAlias(alias)) {
      KeyGenerator g = KeyGenerator.getInstance("AES", "AndroidKeyStore");
      g.init(new KeyGenParameterSpec
              .Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .build());
      g.generateKey();
    }
    return (SecretKey) store.getKey(alias, null);
  }
  private static boolean historyExists(AtomicFile file) {
    return file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists();
  }
  private JSONArray readHistory(Context c) throws Exception {
    AtomicFile f = historyFile(c);
    if (!historyExists(f))
      return new JSONArray();
    byte[] data = f.readFully();
    if (data.length < 29 || data.length > 128 * 1024)
      throw new IOException();
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOf(data, 12)));
    cipher.updateAAD(config.historyKeyAlias.getBytes(StandardCharsets.UTF_8));
    JSONArray all = new JSONArray(
                  new String(cipher.doFinal(Arrays.copyOfRange(data, 12, data.length)),
                      StandardCharsets.UTF_8)),
              kept = new JSONArray();
    long now = System.currentTimeMillis();
    for (int i = 0; i < all.length(); i++)
      if (NotificationMirrorPolicy.retained(all.getJSONObject(i).getLong("at"), now))
        kept.put(all.getJSONObject(i));
    return kept;
  }
  private void writeHistory(Context c, JSONArray data) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key());
    cipher.updateAAD(config.historyKeyAlias.getBytes(StandardCharsets.UTF_8));
    byte[] sealed = cipher.doFinal(data.toString().getBytes(StandardCharsets.UTF_8));
    AtomicFile f = historyFile(c);
    FileOutputStream out = null;
    try {
      out = f.startWrite();
      out.write(cipher.getIV());
      out.write(sealed);
      out.getFD().sync();
      f.finishWrite(out);
    } catch (Exception fail) {
      if (out != null)
        f.failWrite(out);
      throw fail;
    }
  }
  private void recordEvent(Context c, JSONObject app, long posted, String state) throws Exception {
    JSONArray old = readHistory(c), next = new JSONArray();
    next.put(new JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("packageName", app.getString("packageName"))
            .put("signature", app.getString("signature"))
            .put("appLabel", app.getString("label"))
            .put("at", System.currentTimeMillis())
            .put("postedAt", posted)
            .put("state", state));
    for (int i = 0; i < old.length() && next.length() < NotificationMirrorPolicy.MAX_HISTORY; i++)
      next.put(old.getJSONObject(i));
    writeHistory(c, next);
  }
  private void pruneHistory(Context c, JSONObject p) throws Exception {
    if (!NotificationMirrorPolicy.keepsHistory(
            granted(c), p.optBoolean("enabled"), p.optBoolean("history"), paused(c))) {
      clearHistory(c);
      return;
    }
    if (!historyExists(historyFile(c)))
      return;
    try {
      JSONArray old = readHistory(c), kept = new JSONArray(), selected = p.getJSONArray("apps");
      for (int i = 0; i < old.length() && kept.length() < NotificationMirrorPolicy.MAX_HISTORY;
          i++) {
        JSONObject row = old.getJSONObject(i);
        for (int j = 0; j < selected.length(); j++) {
          JSONObject app = selected.getJSONObject(j);
          if (row.optString("packageName").equals(app.optString("packageName"))
              && row.optString("signature").equals(app.optString("signature"))
              && validSignature(c, app)) {
            kept.put(row);
            break;
          }
        }
      }
      writeHistory(c, kept);
    } catch (Exception unavailable) {
      historyFailures.add(c.getPackageName());
      throw unavailable;
    }
  }
  /** Retained post/remove events for still-selected apps: label, time and state only. */
  public JSONArray history(Context c) throws Exception {
    synchronized (lock) {
      JSONObject p = policy(c);
      pruneHistory(c, p);
      if (!active(c, p) || !p.optBoolean("history") || locked(c))
        return new JSONArray();
      JSONArray kept = readHistory(c);
      writeHistory(c, kept);
      JSONArray out = new JSONArray();
      for (int i = 0; i < kept.length(); i++) {
        JSONObject row = kept.getJSONObject(i);
        out.put(new JSONObject()
                .put("id", row.getString("id"))
                .put("appLabel", row.getString("appLabel"))
                .put("at", row.getLong("at"))
                .put("state", row.getString("state")));
      }
      return out;
    }
  }
  /**
   * Owner Clear is an event boundary: queued observations from before it cannot repopulate
   * history.
   */
  public void clearHistoryBoundary(Context c) {
    synchronized (lock) {
      invalidate();
      clearHistory(c);
    }
  }
  public void clearHistory(Context c) {
    synchronized (lock) {
      AtomicFile file = historyFile(c);
      file.delete();
      if (file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists()
          || new File(file.getBaseFile().getPath() + ".new").exists())
        throw new IllegalStateException("History cleanup unavailable");
      historyFailures.remove(c.getPackageName());
    }
  }
}

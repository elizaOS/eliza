// spec/os/android/notificationProjection.md, "An occurrence alert leaves the updates channel only while the owner left that channel as the host made it"; spec/os/android/notificationMirror.md, "A host with account custody activates collection only for the native owner bound to its policy"
package ai.eliza.plugins.notifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 36}, manifest = Config.NONE)
public final class NativeNotificationChannelsTest {
  private static final String OWNER = "c".repeat(64);
  private static final String HOST_GROUP = "host-reminders";
  private Context context;
  private NotificationManager manager;

  @Before public void grantNotifications() {
    context = RuntimeEnvironment.getApplication();
    shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
    manager = context.getSystemService(NotificationManager.class);
  }

  @After public void forgetHostGroups() {
    NativeNotificationChannels.setHostAssignedGroups(Set.of());
  }

  private void updatesInGroup(String group, boolean blocked) {
    NotificationChannelGroup created = new NotificationChannelGroup(group, "Reminders");
    if (blocked) ReflectionHelpers.setField(created, "mBlocked", true);
    manager.createNotificationChannelGroup(created);
    NotificationChannel updates = new NotificationChannel("eliza_updates", "Eliza updates", NotificationManager.IMPORTANCE_DEFAULT);
    updates.setGroup(group);
    manager.createNotificationChannel(updates);
  }

  private static JSONObject reminder(String priority) throws Exception {
    return new JSONObject().put("id", UUID.randomUUID().toString()).put("nativeEpoch", UUID.randomUUID().toString()).put("nativeSequence", 1)
        .put("title", "Dentist").put("body", "Thursday at 9").put("category", "reminder").put("priority", priority)
        .put("createdAt", 1_760_000_000_000L).put("data", new JSONObject().put("ownerType", "occurrence"));
  }

  private String occurrenceChannel() {
    return NativeNotificationChannels.resolveReminderChannel(manager, "high", "occurrence").getId();
  }

  @Test public void notificationConsentSurvivesOnlyTheSameOwnerAndClearConsumesItsRevision() throws Exception {
    AtomicReference<String> owner = new AtomicReference<>("one");
    NotificationMirrorConfig config = new NotificationMirrorConfig("owner-scoped-mirror", "owner-scoped-history",
        "owner-scoped-history.enc", NotificationMirrorListenerService.class);
    NotificationMirror mirror = new NotificationMirror(config, ignored -> owner.get());
    assertTrue(mirror.reconcileOwner(context));
    String blank = mirror.status(context).getString("revision");
    String consent = mirror.update(context, new JSONObject().put("expectedRevision", blank)
        .put("enabled", true).put("history", true)).getString("revision");
    mirror.pause(context, true);

    NotificationMirror restarted = new NotificationMirror(config, ignored -> owner.get());
    owner.set(null);
    assertFalse(restarted.reconcileOwner(context));
    assertThrows(IllegalStateException.class, () -> restarted.status(context));
    assertThrows(IllegalStateException.class, () -> restarted.history(context));
    owner.set("one");
    assertTrue(restarted.reconcileOwner(context));
    JSONObject restored = restarted.status(context);
    assertEquals(consent, restored.getString("revision"));
    assertTrue(restored.getBoolean("enabled"));
    assertTrue(restored.getBoolean("history"));
    assertTrue(restored.getBoolean("paused"));

    String resumed = restarted.resumeAt(context, consent).getString("revision");
    assertNotEquals(consent, resumed);
    assertThrows(IllegalStateException.class, () -> restarted.clearHistoryBoundary(context, consent));
    restarted.clearHistoryBoundary(context, resumed);
    String cleared = restarted.status(context).getString("revision");
    assertNotEquals(resumed, cleared);
    assertThrows(IllegalStateException.class, () -> restarted.clearHistoryBoundary(context, resumed));

    owner.set("two");
    assertThrows(IllegalStateException.class, () -> restarted.status(context));
    assertThrows(IllegalStateException.class, () -> restarted.clearHistoryBoundary(context, cleared));
    assertTrue(restarted.reconcileOwner(context));
    JSONObject different = restarted.status(context);
    assertNotEquals(cleared, different.getString("revision"));
    assertFalse(different.getBoolean("enabled"));
    assertFalse(different.getBoolean("history"));
    assertEquals(0, different.getJSONArray("apps").length());
    assertThrows(IllegalStateException.class, () -> restarted.resumeAt(context, cleared));
  }

  @Test public void hostAssignedGroupIsNotAnOccurrenceCustomisation() throws Exception {
    NativeNotificationChannels.setHostAssignedGroups(Set.of(HOST_GROUP));
    updatesInGroup(HOST_GROUP, false);
    String expected = Build.VERSION.SDK_INT < 30 ? "eliza_updates" : "eliza_notifications";
    assertEquals(expected, occurrenceChannel());
    assertTrue(NativeNotificationProjector.post(context, Activity.class, OWNER, reminder("high")));
    assertEquals(1, manager.getActiveNotifications().length);
    assertEquals(expected, manager.getActiveNotifications()[0].getNotification().getChannelId());
  }

  @Test public void unassignedGroupStaysTheOwnersChoice() {
    updatesInGroup("owner-group", false);
    assertEquals("eliza_updates", occurrenceChannel());
    NativeNotificationChannels.setHostAssignedGroups(Set.of(HOST_GROUP));
    assertEquals("eliza_updates", occurrenceChannel());
  }

  @Test public void blockedHostAssignedGroupKeepsTheOccurrenceBlocked() throws Exception {
    NativeNotificationChannels.setHostAssignedGroups(Set.of(HOST_GROUP));
    updatesInGroup(HOST_GROUP, true);
    assertEquals("eliza_updates", occurrenceChannel());
    assertTrue(NativeNotificationChannels.isReminderChannelBlocked(manager, manager.getNotificationChannel("eliza_updates")));
    assertFalse(NativeNotificationProjector.post(context, Activity.class, OWNER, reminder("high")));
    assertEquals(0, manager.getActiveNotifications().length);
    assertNull(manager.getNotificationChannel("eliza_notifications"));
  }

  @Test public void nothingIsPostedIntoABlockedGroup() throws Exception {
    updatesInGroup("muted-reminders", true);
    assertFalse(NativeNotificationProjector.post(context, Activity.class, OWNER, reminder("normal")));
    assertFalse(NativeNotificationProjector.post(context, Activity.class, OWNER, reminder("high")));
    assertEquals(0, manager.getActiveNotifications().length);
    assertNull(manager.getNotificationChannel("eliza_notifications"));
  }

  @Test public void otherPrioritiesKeepTheirOwnChannels() {
    NativeNotificationChannels.setHostAssignedGroups(Set.of(HOST_GROUP));
    updatesInGroup("owner-group", false);
    assertEquals("eliza_alerts", NativeNotificationChannels.resolveReminderChannel(manager, "urgent", "occurrence").getId());
    assertEquals("eliza_notifications", NativeNotificationChannels.resolveReminderChannel(manager, "high", "reminder").getId());
    assertEquals("eliza_updates", NativeNotificationChannels.resolveReminderChannel(manager, "normal", "occurrence").getId());
    assertEquals("eliza_quiet", NativeNotificationChannels.resolveReminderChannel(manager, "low", "occurrence").getId());
  }
}

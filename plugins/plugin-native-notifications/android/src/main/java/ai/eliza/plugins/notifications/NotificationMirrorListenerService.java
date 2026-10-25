package ai.eliza.plugins.notifications;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Base listener for the opt-in mirror. The host declares its concrete subclass in its manifest
 * (exported, BIND_NOTIFICATION_LISTENER_SERVICE) and returns the same configured mirror from
 * {@link #mirror()}. Android alone binds it; it performs no network or agent forwarding.
 */
public abstract class NotificationMirrorListenerService extends NotificationListenerService {
  private final ThreadPoolExecutor events = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(64), new ThreadPoolExecutor.AbortPolicy());
  private final BroadcastReceiver screen = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
      mirror().redact();
    }
  };
  /** The host's single configured mirror; the same instance on every call. */
  protected abstract NotificationMirror mirror();
  /** Pending callback work, exposed for host instrumentation of queue bounds. */
  protected final ThreadPoolExecutor events() {
    return events;
  }
  @Override
  public void onCreate() {
    super.onCreate();
    IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
    if (Build.VERSION.SDK_INT >= 33)
      registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED);
    else
      registerReceiver(screen, filter);
  }
  @Override
  public void onListenerConnected() {
    mirror().connected(this);
  }
  @Override
  public void onListenerDisconnected() {
    events.getQueue().clear();
    mirror().disconnected(this);
  }
  private void enqueue(StatusBarNotification notice, boolean removed) {
    if (notice == null)
      return;
    NotificationMirror mirror = mirror();
    final long generation = mirror.eventGeneration();
    mirror.invalidateKey(notice.getKey());
    try {
      events.execute(() -> mirror.changed(this, notice, removed, generation));
    } catch (RejectedExecutionException unavailable) {
      mirror.redact();
      events.getQueue().clear();
    }
  }
  @Override
  public void onNotificationPosted(StatusBarNotification notice) {
    enqueue(notice, false);
  }
  @Override
  public void onNotificationRemoved(StatusBarNotification notice) {
    enqueue(notice, true);
  }
  @Override
  public void onDestroy() {
    unregisterReceiver(screen);
    events.shutdownNow();
    mirror().disconnected(this);
    super.onDestroy();
  }
}

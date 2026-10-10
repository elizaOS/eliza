package example.mirrorfixture;
import android.app.*;
import android.content.*;
import java.util.UUID;
/** Synthetic notices only. Each test controls an exact random namespace. */
public final class PostReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context c, Intent i) {
    String nonce = i.getStringExtra("nonce");
    if (nonce == null || !UUID.fromString(nonce).toString().equals(nonce))
      throw new IllegalArgumentException("Exact fixture nonce required");
    NotificationManager manager = c.getSystemService(NotificationManager.class);
    if ("clear".equals(i.getStringExtra("operation"))) {
      manager.cancelAll();
      return;
    }
    manager.createNotificationChannel(
        new NotificationChannel(nonce, "Synthetic", NotificationManager.IMPORTANCE_LOW));
    for (int id = 1; id <= 2; id++)
      manager.notify(nonce, id,
          new Notification.Builder(c, nonce)
              .setGroup(nonce).setSmallIcon(android.R.drawable.ic_dialog_info)
              .setContentTitle("Synthetic " + nonce + " " + id)
              .setContentText("Canary " + nonce)
              .setVisibility(
                  id == 2 ? Notification.VISIBILITY_SECRET : Notification.VISIBILITY_PUBLIC)
              .build());
  }
}

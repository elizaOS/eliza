package example.mirror;
import ai.eliza.plugins.notifications.*;
public final class TestListener extends NotificationMirrorListenerService {
  public static final NotificationMirror MIRROR =
      new NotificationMirror(new NotificationMirrorConfig(
          "consumer-policy", "consumer-key", "consumer-history.enc", TestListener.class));
  @Override
  protected NotificationMirror mirror() {
    return MIRROR;
  }
}

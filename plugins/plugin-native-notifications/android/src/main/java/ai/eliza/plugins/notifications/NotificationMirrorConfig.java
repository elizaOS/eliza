package ai.eliza.plugins.notifications;

/**
 * Host configuration for one notification mirror. Every field is migration-sensitive: a host
 * adopting this module keeps its existing preference name, Keystore alias, history file name and
 * listener component so an installed owner's opt-in policy and history keep their meaning.
 */
public final class NotificationMirrorConfig {
  private static final java.util.regex.Pattern NAME =
      java.util.regex.Pattern.compile("[a-z][a-z0-9._-]{0,63}");
  public final String preferencesName, historyKeyAlias, historyFileName;
  /**
   * The host's concrete {@code NotificationMirrorListenerService} subclass, declared in its
   * manifest.
   */
  public final Class<?> listener;
  public NotificationMirrorConfig(
      String preferencesName, String historyKeyAlias, String historyFileName, Class<?> listener) {
    if (!valid(preferencesName) || !valid(historyKeyAlias) || !valid(historyFileName))
      throw new IllegalArgumentException(
          "Notification mirror names must be bounded lowercase identifiers");
    if (listener == null)
      throw new IllegalArgumentException(
          "Notification mirror requires the host listener component");
    if (preferencesName.equals(historyFileName))
      throw new IllegalArgumentException("Notification mirror storage names must be distinct");
    this.preferencesName = preferencesName;
    this.historyKeyAlias = historyKeyAlias;
    this.historyFileName = historyFileName;
    this.listener = listener;
  }
  private static boolean valid(String value) {
    return value != null && NAME.matcher(value).matches();
  }
}

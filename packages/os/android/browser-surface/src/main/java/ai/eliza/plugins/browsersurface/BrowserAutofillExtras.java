package ai.eliza.plugins.browsersurface;

/**
 * The Android Autofill extras a host's password provider reads from browser login fields: the
 * per-field origin and the committed top-level origin. Hosts that use {@code
 * plugin-native-passwords} pass {@code PasswordAutofillPolicy.FIELD_ORIGIN} and {@code
 * PasswordFormPolicy.TOP_ORIGIN_EXTRA}; this module does not depend on the vault. The values are
 * written only from an engine-attested or engine-bound origin, never from page content.
 */
public final class BrowserAutofillExtras {
  public final String fieldOrigin;
  public final String topOrigin;

  public BrowserAutofillExtras(String fieldOrigin, String topOrigin) {
    if (fieldOrigin == null || fieldOrigin.isEmpty() || topOrigin == null || topOrigin.isEmpty()
        || fieldOrigin.equals(topOrigin))
      throw new IllegalArgumentException("Two distinct autofill extra keys are required");
    this.fieldOrigin = fieldOrigin;
    this.topOrigin = topOrigin;
  }
}

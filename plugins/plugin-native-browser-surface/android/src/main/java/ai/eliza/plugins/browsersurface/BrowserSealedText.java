package ai.eliza.plugins.browsersurface;

/**
 * Host port that seals browser records at rest. Saved addresses, history and site-permission
 * origins reveal what a person visited and may carry private query parameters, so the shared
 * stores never write them in clear text. The host supplies its own key (for example an Android
 * Keystore AES-GCM frame) and keeps its key alias, so records written by earlier builds still open.
 */
public interface BrowserSealedText {
  /** Returns the sealed form of {@code plain}; throws when the key is unavailable. */
  String seal(String plain) throws Exception;

  /** Returns the plain text of {@code sealed}; throws when the record is damaged or the key changed. */
  String open(String sealed) throws Exception;
}

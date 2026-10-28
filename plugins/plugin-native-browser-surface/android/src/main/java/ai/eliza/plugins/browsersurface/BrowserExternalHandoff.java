package ai.eliza.plugins.browsersurface;

import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import java.util.Locale;
import java.util.Set;

/**
 * Android intents for links a page hands to another app, and the resolver probe for an explicit
 * "open in another browser" handoff. The decisions are {@link BrowserExternalLinkPolicy} and
 * {@link BrowserExternalPage}; this class only builds or inspects Android objects.
 *
 * <p>Every link handoff is an implicit, browsable request with no component, selector, clip data,
 * extras or permission-granting flags, so a page cannot address a specific private activity or
 * grant URI access. The host's own package and the URI schemes of its own routes are refused.
 */
public final class BrowserExternalHandoff {
  private BrowserExternalHandoff() {}

  /** Whether {@code raw} is a link another app handles (mailto, tel, market, intent). */
  public static boolean external(String raw) {
    return BrowserExternalLinkPolicy.external(raw);
  }

  /**
   * A sanitized implicit intent for {@code raw}, or null when the link must be refused.
   *
   * @param ownPackage the host's package, which a page may never address
   * @param hostSchemes the URI schemes of the host's own routes, which an intent: URI may never carry
   */
  public static Intent intentFor(String raw, String ownPackage, Set<String> hostSchemes) {
    if (raw == null || raw.length() > BrowserExternalLinkPolicy.MAX_LINK
        || raw.matches("(?s).*[\\x00-\\x1f\\x7f].*")) return null;
    Uri uri;
    try {
      uri = Uri.parse(raw);
    } catch (Exception invalid) {
      return null;
    }
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    Intent intent;
    switch (scheme) {
      case "mailto":
        intent = new Intent(Intent.ACTION_SENDTO, uri);
        break;
      case "tel":
        // DIAL only opens the dialer with the number; it never places a call.
        intent = new Intent(Intent.ACTION_DIAL, uri);
        break;
      case "market":
        intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
        break;
      case "intent": {
        Intent parsed;
        try {
          parsed = Intent.parseUri(raw, Intent.URI_INTENT_SCHEME);
        } catch (Exception invalid) {
          return null;
        }
        Uri data = parsed.getData();
        String dataScheme = data == null ? null : (data.getScheme() == null ? "" : data.getScheme());
        if (BrowserExternalLinkPolicy.decide(raw, true, parsed.getAction(), dataScheme,
                parsed.getPackage(), ownPackage, hostSchemes)
            == BrowserExternalLinkPolicy.Handoff.REFUSE) return null;
        intent = new Intent(Intent.ACTION_VIEW);
        if (data != null) intent.setDataAndType(data, parsed.getType());
        else if (parsed.getType() != null) intent.setType(parsed.getType());
        if (parsed.getPackage() != null) intent.setPackage(parsed.getPackage());
        // No page-supplied extras are forwarded; browser_fallback_url is read by fallback().
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        break;
      }
      default:
        return null;
    }
    // A fresh Intent never inherits a page-chosen component, selector, clip data or URI-grant
    // flags. Re-assert that for defence in depth.
    intent.setComponent(null);
    intent.setSelector(null);
    intent.setClipData(null);
    intent.setFlags(0);
    return intent;
  }

  /** Safe HTTPS fallback named by an intent: URI, or null. */
  public static String fallback(String raw) {
    if (raw == null || !raw.regionMatches(true, 0, "intent:", 0, 7)) return null;
    try {
      return BrowserExternalLinkPolicy.fallback(
          Intent.parseUri(raw, Intent.URI_INTENT_SCHEME).getStringExtra("browser_fallback_url"));
    } catch (Exception invalid) {
      return null;
    }
  }

  /** The query for installed browsers: a general HTTPS view on a reserved, never-resolving host. */
  public static Intent browserProbe() {
    return new Intent(Intent.ACTION_VIEW, Uri.parse("https://browser-handoff.invalid/"))
        .addCategory(Intent.CATEGORY_DEFAULT)
        .addCategory(Intent.CATEGORY_BROWSABLE);
  }

  /** Whether a resolved filter handles every HTTPS link, rather than one site's host or path. */
  public static boolean genericHttps(IntentFilter filter) {
    return filter != null && filter.hasAction(Intent.ACTION_VIEW)
        && filter.hasCategory(Intent.CATEGORY_DEFAULT)
        && filter.hasCategory(Intent.CATEGORY_BROWSABLE) && filter.hasDataScheme("https")
        && filter.countDataAuthorities() == 0 && filter.countDataPaths() == 0
        && filter.countDataSchemeSpecificParts() == 0 && filter.countDataTypes() == 0;
  }
}

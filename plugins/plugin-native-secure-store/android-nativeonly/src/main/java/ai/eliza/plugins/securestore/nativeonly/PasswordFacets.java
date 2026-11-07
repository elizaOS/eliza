package ai.eliza.plugins.securestore.nativeonly;

import java.io.IOException;
import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Pure normalization for password entry bindings ("facets"). No Android dependencies,
 * so the exact matching rules can be tested on a plain JVM.
 *
 * <ul>
 *   <li>Web: {@code https://host[:port]} with a lowercase ASCII host and no path, query,
 *   fragment or user info. The default port is omitted.</li>
 *   <li>Android app: {@code android://<sha256 hex of signing certificate>@<package>}.</li>
 * </ul>
 *
 * Matching is exact. A binding for {@code https://example.com} does not match
 * {@code https://accounts.example.com}; hosts add one binding per origin they trust.
 */
public final class PasswordFacets {
  private PasswordFacets() {}

  private static final Pattern PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+");
  private static final Pattern CERT = Pattern.compile("[a-f0-9]{64}");
  private static final Pattern HOST = Pattern.compile("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*");
  public static final int MAX_LENGTH = 512;

  /**
   * Normalizes like {@link PasswordVaultStore#origin(String)}, and additionally validates ASCII
   * host syntax and drops a trailing root dot. The legacy method is left unchanged so existing
   * browser-metadata validation and stored legacy origins keep their behavior.
   */
  public static String web(String input) throws IOException {
    if (input == null || input.length() > MAX_LENGTH) throw new IOException("Use an HTTPS website address without a path");
    URI uri;
    try { uri = new URI(input.trim()); } catch (Exception invalid) { throw new IOException("Use an HTTPS website address without a path"); }
    if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null
        || uri.getRawFragment() != null || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
        || uri.getPort() < -1 || uri.getPort() > 65535) throw new IOException("Use an HTTPS website address without a path");
    String host = uri.getHost().toLowerCase(Locale.ROOT);
    if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
    if (host.length() > 253 || !HOST.matcher(host).matches()) throw new IOException("Use an HTTPS website address without a path");
    try {
      return new URI("https", null, host, uri.getPort() == 443 ? -1 : uri.getPort(), null, null, null).toASCIIString();
    } catch (Exception invalid) { throw new IOException("Use an HTTPS website address without a path"); }
  }

  /** A web facet from framework-reported autofill metadata: scheme and bare host. */
  public static String webDomain(String scheme, String domain) throws IOException {
    if (!"https".equals(scheme) || domain == null || domain.isEmpty() || domain.contains("/") || domain.contains("@")) throw new IOException("Unsupported web origin");
    return web("https://" + domain);
  }

  public static String android(String packageName, String certificateSha256) throws IOException {
    if (packageName == null || packageName.length() > 255 || !PACKAGE.matcher(packageName).matches()) throw new IOException("Invalid app package");
    String cert = certificateSha256 == null ? "" : certificateSha256.toLowerCase(Locale.ROOT);
    if (!CERT.matcher(cert).matches()) throw new IOException("Invalid app signing certificate");
    return "android://" + cert + "@" + packageName;
  }

  public static boolean isWeb(String facet) { return facet != null && facet.startsWith("https://"); }
  public static boolean isAndroid(String facet) { return facet != null && facet.startsWith("android://"); }

  /** Package of an Android facet, or null. */
  public static String androidPackage(String facet) {
    if (!isAndroid(facet)) return null;
    int at = facet.indexOf('@');
    return at < 0 ? null : facet.substring(at + 1);
  }

  /** Certificate digest (lowercase hex) of an Android facet, or null. */
  public static String androidCertificate(String facet) {
    if (!isAndroid(facet)) return null;
    int at = facet.indexOf('@');
    return at < 0 ? null : facet.substring("android://".length(), at);
  }

  /** Returns the canonical form of a stored or supplied facet, rejecting anything else. */
  public static String normalize(String facet) throws IOException {
    if (facet == null || facet.length() > MAX_LENGTH) throw new IOException("Invalid binding");
    if (isAndroid(facet)) return android(androidPackage(facet), androidCertificate(facet));
    return web(facet);
  }
}

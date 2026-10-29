package ai.eliza.plugins.agent.connection;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONTokener;

/**
 * Input and output bounds of a first-party renderer transport: URL validation, strict JSON,
 * bounded bodies, header values and Retry-After. Pure Java plus org.json, so it is tested on the
 * host JVM; the Capacitor plugin keeps only the Android plumbing.
 */
public final class ConnectionTransport {
  private ConnectionTransport() {}

  /** Default response and request body cap. */
  public static final int RESPONSE_LIMIT = 2 * 1024 * 1024;
  /** Longest URL or header value the transport accepts. */
  public static final int VALUE_LIMIT = 16384;

  /** A non-empty value no longer than max, else IllegalArgumentException. */
  public static String required(String value, int max) {
    if (value == null || value.isEmpty() || value.length() > max) throw new IllegalArgumentException();
    return value;
  }

  /** Exactly one JSON value with nothing but whitespace after it. */
  public static Object parseJson(String value) throws Exception {
    JSONTokener parser = new JSONTokener(value);
    Object parsed = parser.nextValue();
    if (parser.nextClean() != 0) throw new IllegalArgumentException();
    return parsed;
  }

  /** Reads input up to limit bytes; one byte more is IllegalArgumentException. A null stream is empty. */
  public static byte[] readBounded(InputStream input, int limit) throws Exception {
    if (input == null) return new byte[0];
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int count;
    while ((count = input.read(buffer)) != -1) {
      if (output.size() + count > limit) throw new IllegalArgumentException();
      output.write(buffer, 0, count);
    }
    return output.toByteArray();
  }

  /**
   * An absolute HTTPS URL with a host, no user info, no fragment and a valid port. Plain HTTP to
   * the emulator or loopback development agent is admitted only when allowDevelopment and the
   * build has test mocks.
   */
  public static URI validatedUrl(String text, boolean allowDevelopment, boolean testMocks) throws Exception {
    URI url = new URI(required(text, VALUE_LIMIT));
    String host = url.getHost(), scheme = url.getScheme();
    if (host == null || url.getRawUserInfo() != null || url.getRawFragment() != null || url.getPort() == 0 || url.getPort() > 65535)
      throw new IllegalArgumentException();
    boolean development =
        allowDevelopment && testMocks && "http".equals(scheme) && ("127.0.0.1".equals(host) || "10.0.2.2".equals(host));
    if (!"https".equals(scheme) && !development) throw new IllegalArgumentException();
    return url;
  }

  /** A forwarded header value: bounded and free of line breaks. */
  public static boolean headerValue(String value) {
    return value != null && value.length() <= VALUE_LIMIT && !value.contains("\r") && !value.contains("\n");
  }

  /** A Retry-After (seconds or an HTTP date) safe to hand to the renderer, else null. */
  public static String retryAfter(String value) {
    return value != null && value.matches("[A-Za-z0-9 ,:+-]{1,64}") ? value : null;
  }

  /**
   * A comma-separated device-capability declaration: each token from allowed, at most once, no line
   * breaks; and no token together with any token it excludes ({@code exclusive} pairs).
   */
  public static boolean deviceCapabilities(String value, Set<String> allowed, String[][] exclusive) {
    if (value == null || value.contains("\r") || value.contains("\n")) return false;
    String[] parts = value.split(",", -1);
    if (parts.length < 1 || parts.length > allowed.size()) return false;
    Set<String> seen = new HashSet<>();
    for (String part : parts) {
      String token = part.trim();
      if (!allowed.contains(token) || !seen.add(token)) return false;
    }
    if (exclusive != null) for (String[] pair : exclusive) if (seen.contains(pair[0]) && seen.contains(pair[1])) return false;
    return true;
  }
}

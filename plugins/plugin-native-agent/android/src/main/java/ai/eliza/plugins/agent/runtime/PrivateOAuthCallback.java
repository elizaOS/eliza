package ai.eliza.plugins.agent.runtime;

import java.net.URI;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

/** Native-only callback admission. Delivery is not proof of account linking.
 * Hosts must strip handled intent data before any WebView/lifecycle forwarding.
 * The private sink owns state, PKCE, account binding and single-use exchange.
 * This class never persists callbacks, logs exceptions, or returns callback data.
 */
public final class PrivateOAuthCallback {
  public enum Admission { NOT_MATCHED, REJECTED, QUEUED, BUSY }
  @FunctionalInterface public interface Sink { void accept(String callback) throws Exception; }
  private final URI expected;
  private final Executor executor;
  private final Sink sink;
  private final Runnable deliveryFailed;

  public PrivateOAuthCallback(String redirect, Executor executor, Sink sink, Runnable deliveryFailed) {
    URI parsed = URI.create(Objects.requireNonNull(redirect));
    if (!"https".equals(parsed.getScheme()) || parsed.getHost() == null ||
        parsed.getRawUserInfo() != null || parsed.getRawQuery() != null || parsed.getRawFragment() != null ||
        parsed.getRawPath() == null || parsed.getRawPath().isEmpty() || !parsed.normalize().equals(parsed))
      throw new IllegalArgumentException("An explicit HTTPS callback is required");
    this.expected = parsed;
    this.executor = Objects.requireNonNull(executor);
    this.sink = Objects.requireNonNull(sink);
    this.deliveryFailed = Objects.requireNonNull(deliveryFailed);
  }

  public Admission accept(String callback) {
    if (callback == null) return Admission.NOT_MATCHED;
    final URI value;
    try { value = URI.create(callback); } catch (IllegalArgumentException invalid) { return Admission.REJECTED; }
    if (!expected.getScheme().equals(value.getScheme()) || !expected.getHost().equalsIgnoreCase(value.getHost()) ||
        expected.getPort() != value.getPort() || !expected.getRawPath().equals(value.getRawPath()))
      return Admission.NOT_MATCHED;
    if (callback.length() > 8192 || value.getRawUserInfo() != null || value.getRawFragment() != null ||
        value.getRawQuery() == null || value.getRawQuery().isEmpty()) return Admission.REJECTED;
    try {
      executor.execute(() -> {
        try { sink.accept(callback); }
        catch (Exception failure) { deliveryFailed.run(); }
      });
      return Admission.QUEUED;
    } catch (RejectedExecutionException busy) {
      return Admission.BUSY;
    }
  }
}

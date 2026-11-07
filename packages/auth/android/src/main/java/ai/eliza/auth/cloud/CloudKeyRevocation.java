package ai.eliza.auth.cloud;

import java.net.HttpURLConnection;
import java.net.URI;

/**
 * Best-effort server-side revocation of a saved Cloud sign-in key: one DELETE of the presented key's
 * own self-revocation route, short timeouts, never retried, and every failure is ignored. Used for a
 * key a new sign-in replaced and for a confirmed local reset; the key also expires on its own.
 *
 * <p>{@link #revokeSaved} is the bounded reset step: it revokes every registered environment's saved
 * key on an interrupted daemon worker and returns within its budget (capped at
 * {@link #RESET_BUDGET_CAP_MS}) whatever the network or credential store does. {@link #resetStep}
 * adapts it to a data-reset coordinator's before-dispatch hook, for example
 * {@code DataReset.builder(...).beforeDispatch(CloudKeyRevocation.resetStep(() -> REGISTRATION,
 * Store::readSlot)::run)}; the coordinator runs it only while a confirmed reset is pending.
 */
public final class CloudKeyRevocation {
 private CloudKeyRevocation() {}
 public static final int TIMEOUT_MS = 3000;
 public static String endpoint(CloudSignInEnvironment environment) { return environment.api() + CloudSignInRoutes.SELF_REVOCATION; }
 /** The bearer value of a saved Cloud credential, or null. Only a printable ASCII token is used. */
 public static String bearer(String token) {
  if (token == null || token.length() < 8 || token.length() > 16384) return null;
  for (int i = 0; i < token.length(); i++) if (token.charAt(i) <= 0x20 || token.charAt(i) >= 0x7f) return null;
  return token;
 }
 /** Upper bound for {@link #revokeSaved}, whatever budget the caller passes. */
 public static final long RESET_BUDGET_CAP_MS = 8000;

 /** Reads a saved credential slot's raw value (the sign-in client's JSON record), or null. */
 public interface SavedSlots<C> { String read(C context, String slot) throws Exception; }
 /** One revocation attempt; {@link #revoke} in production, injectable for host tests. */
 public interface Transport { boolean revoke(CloudSignInConfig config, CloudSignInEnvironment environment, String token); }
 /** A before-dispatch step with the coordinator's {@code (context, timeoutMs)} shape. */
 public interface ResetStep<C> { void run(C context, long timeoutMs); }
 /** The live registration, read at reset time so a build's registered environments are honoured. */
 public interface Registration { CloudSignInConfig get(); }

 public static <C> ResetStep<C> resetStep(Registration registration, SavedSlots<C> slots) {
  return resetStep(registration, slots, CloudKeyRevocation::revoke);
 }
 public static <C> ResetStep<C> resetStep(Registration registration, SavedSlots<C> slots, Transport transport) {
  if (registration == null || slots == null || transport == null) throw new IllegalArgumentException("reset revocation ports");
  return (context, timeoutMs) -> revokeSaved(registration.get(), slot -> slots.read(context, slot), timeoutMs, transport);
 }

 /** Context-free reader used by {@link #revokeSaved}. */
 public interface SlotReader { String read(String slot) throws Exception; }

 /**
  * Best effort: revokes each registered environment's saved key, in registration order, on a daemon
  * worker. Returns after at most min(timeoutMs, {@link #RESET_BUDGET_CAP_MS}) and then interrupts the
  * worker; an unreadable slot, damaged record or failed request skips only that environment. Never
  * throws and never removes the saved credential (the local reset does that). Returns the number of
  * revocations the server confirmed before the deadline.
  */
 public static int revokeSaved(CloudSignInConfig config, SlotReader slots, long timeoutMs) {
  return revokeSaved(config, slots, timeoutMs, CloudKeyRevocation::revoke);
 }
 public static int revokeSaved(CloudSignInConfig config, SlotReader slots, long timeoutMs, Transport transport) {
  if (config == null || slots == null || transport == null || timeoutMs <= 0 || Thread.currentThread().isInterrupted()) return 0;
  final long deadline = System.nanoTime() + Math.min(timeoutMs, RESET_BUDGET_CAP_MS) * 1_000_000L;
  final java.util.concurrent.atomic.AtomicInteger confirmed = new java.util.concurrent.atomic.AtomicInteger();
  Thread worker = new Thread(() -> {
   for (CloudSignInEnvironment environment : config.environments()) {
    if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) return;
    try {
     String saved = slots.read(config.credentialSlot(environment));
     String token = saved == null ? null : new org.json.JSONObject(saved).optString("token", null);
     if (bearer(token) != null && System.nanoTime() < deadline && transport.revoke(config, environment, token)) confirmed.incrementAndGet();
    } catch (Exception unavailable) { /* The local reset must still proceed. */ }
   }
  }, "eliza-reset-key-revocation");
  worker.setDaemon(true);
  worker.start();
  try {
   long remaining = deadline - System.nanoTime();
   if (remaining > 0) worker.join(Math.max(1, remaining / 1_000_000L));
  } catch (InterruptedException interrupted) {
   Thread.currentThread().interrupt();
  } finally {
   worker.interrupt();
  }
  return confirmed.get();
 }

 /** One attempt. Returns true only for a 2xx answer; never throws. */
 public static boolean revoke(CloudSignInConfig config, CloudSignInEnvironment environment, String token) {
  HttpURLConnection connection = null;
  try {
   String value = bearer(token); if (value == null) return false;
   URI url = URI.create(endpoint(environment));
   if (!CloudSignInRoutes.selfRevocation(config, url.getScheme(), url.getHost(), url.getPort(), url.getRawPath(), url.getRawQuery(), "DELETE", false)) return false;
   connection = (HttpURLConnection) url.toURL().openConnection();
   connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
   connection.setConnectTimeout(TIMEOUT_MS); connection.setReadTimeout(TIMEOUT_MS);
   connection.setRequestMethod("DELETE");
   connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Authorization", "Bearer " + value);
   int status = connection.getResponseCode();
   return status >= 200 && status < 300;
  } catch (Exception ignored) { return false; }
  finally { if (connection != null) connection.disconnect(); }
 }
}

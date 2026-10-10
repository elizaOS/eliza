package ai.eliza.plugins.passwords;

import java.security.SecureRandom;
import java.util.function.LongSupplier;

/**
 * In-memory, one-shot capabilities linking an Autofill request to the picker or save Activity.
 * Intents carry only an unguessable token; targets and captured values never enter an Intent,
 * a PendingIntent, disk or logs. A new request replaces the previous one of the same kind.
 * Process death drops pending work, which fails closed.
 */
public final class PasswordRequests {
  public static final long FILL_TTL_MILLIS = 120_000, SAVE_TTL_MILLIS = 300_000;
  private final LongSupplier clock;
  private final SecureRandom random;
  private Pending fill, save;

  /** The verified binding is captured with the values, never recomputed after an unlock. */
  public static final class SaveCapture {
    public final PasswordFormPolicy.Target target;
    public final String facet;
    SaveCapture(PasswordFormPolicy.Target target, String facet) { this.target = target; this.facet = facet; }
  }

  private static final class Pending {
    boolean taken;
    String facet;
    final String token; final PasswordFormPolicy.Target target; final long created; final long ttl;
    Pending(String token, PasswordFormPolicy.Target target, long created, long ttl) { this.token = token; this.target = target; this.created = created; this.ttl = ttl; }
    boolean valid(long now) { return now >= created && now - created < ttl; }
  }

  public PasswordRequests(LongSupplier clock, SecureRandom random) { this.clock = clock; this.random = random; }

  private String token() {
    byte[] bytes = new byte[24]; random.nextBytes(bytes);
    StringBuilder out = new StringBuilder(48);
    for (byte value : bytes) out.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
    return out.toString();
  }

  public synchronized String offerFill(PasswordFormPolicy.Target target) {
    fill = new Pending(token(), target.withoutValues(), clock.getAsLong(), FILL_TTL_MILLIS); return fill.token;
  }

  public synchronized String offerSave(PasswordFormPolicy.Target target, String facet) {
    if (facet == null) throw new IllegalArgumentException("Missing save binding");
    save = new Pending(token(), target, clock.getAsLong(), SAVE_TTL_MILLIS); save.facet = facet; return save.token;
  }

  /** Consumes the current fill offer. Old, replaced, expired or reused tokens return null. */
  public synchronized PasswordFormPolicy.Target takeFill(String token) {
    Pending current = fill;
    if (current == null || current.taken || token == null || !current.token.equals(token)) return null;
    current.taken = true;
    return current.valid(clock.getAsLong()) ? current.target : null;
  }

  /** A picker keeps the original deadline and remains revocable after taking its target. */
  public synchronized boolean currentFill(String token) {
    return fill != null && fill.taken && fill.token.equals(token) && fill.valid(clock.getAsLong());
  }

  /** Atomically finish the still-current request before publishing a result. */
  public synchronized boolean claimFill(String token) {
    if (!currentFill(token)) return false;
    fill = null;
    return true;
  }

  /** Consumes the current save capture, including its captured values. */
  public synchronized SaveCapture takeSave(String token) {
    Pending current = save;
    if (current == null || token == null || !current.token.equals(token)) return null;
    save = null;
    return current.valid(clock.getAsLong()) ? new SaveCapture(current.target, current.facet) : null;
  }

  public synchronized void cancelFill(String token) { if (fill != null && fill.token.equals(token)) fill = null; }

  public synchronized void clear() { fill = null; save = null; }
}

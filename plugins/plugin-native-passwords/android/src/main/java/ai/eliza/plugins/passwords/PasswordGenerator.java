package ai.eliza.plugins.passwords;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/** Native-only password generation. Generated values are stored directly; they are never
 * returned through Capacitor. Pure Java so the distribution rules are JVM-testable. */
public final class PasswordGenerator {
  private PasswordGenerator() {}
  public static final int MIN_LENGTH = 8, MAX_LENGTH = 128, DEFAULT_LENGTH = 20;
  // Ambiguous glyphs (I, l, 1, O, 0) are omitted so a revealed password can be retyped.
  static final String LOWER = "abcdefghijkmnopqrstuvwxyz", UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ", DIGITS = "23456789", SYMBOLS = "!#$%&*+-=?@^_~";

  public static final class Options {
    public final int length;
    public final boolean lowercase, uppercase, digits, symbols;
    public Options(int length, boolean lowercase, boolean uppercase, boolean digits, boolean symbols) {
      this.length = length; this.lowercase = lowercase; this.uppercase = uppercase; this.digits = digits; this.symbols = symbols;
    }
    public static Options defaults() { return new Options(DEFAULT_LENGTH, true, true, true, true); }
  }

  /** Includes at least one character from every selected class; uniform otherwise. */
  public static String generate(Options options, SecureRandom random) {
    if (options == null || random == null) throw new IllegalArgumentException("Missing generator input");
    List<String> classes = new ArrayList<>();
    if (options.lowercase) classes.add(LOWER);
    if (options.uppercase) classes.add(UPPER);
    if (options.digits) classes.add(DIGITS);
    if (options.symbols) classes.add(SYMBOLS);
    if (classes.isEmpty()) throw new IllegalArgumentException("Choose at least one character type");
    if (options.length < MIN_LENGTH || options.length > MAX_LENGTH) throw new IllegalArgumentException("Choose a length from 8 to 128");
    StringBuilder all = new StringBuilder();
    for (String set : classes) all.append(set);
    char[] out = new char[options.length];
    int index = 0;
    for (String set : classes) out[index++] = set.charAt(random.nextInt(set.length()));
    while (index < out.length) out[index++] = all.charAt(random.nextInt(all.length()));
    // Fisher-Yates; SecureRandom.nextInt(bound) is unbiased.
    for (int i = out.length - 1; i > 0; i--) { int j = random.nextInt(i + 1); char swap = out[i]; out[i] = out[j]; out[j] = swap; }
    String value = new String(out);
    java.util.Arrays.fill(out, '\0');
    return value;
  }
}

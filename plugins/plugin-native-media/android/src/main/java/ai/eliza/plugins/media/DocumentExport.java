package ai.eliza.plugins.media;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * Rules for exporting a note or generated document to a destination the owner chooses: strict
 * bounded UTF-8 text, a file title with no path or control characters, and the exact readback that
 * decides between "exported", "unverified" (the provider may hold some or all bytes) and "failed"
 * (nothing was opened for writing). Pure Java; {@link DocumentDestinations} applies these to
 * Android's document provider.
 */
public final class DocumentExport {
  /** Largest exported text, in UTF-16 units and in UTF-8 bytes. */
  public static final int TEXT_LIMIT = 64 * 1024;
  /** Longest exported title, before the extension. */
  public static final int TITLE_LIMIT = 100;

  /** Outcome of a write to a chosen destination. */
  public enum Outcome {
    /** Written and read back exactly. */
    EXPORTED("exported"),
    /** The destination was opened for writing but its bytes could not be confirmed. */
    UNVERIFIED("unverified"),
    /** Nothing was written. */
    FAILED("failed");
    public final String status;
    Outcome(String status) {
      this.status = status;
    }
  }

  private DocumentExport() {}

  /** Strict UTF-8 bytes of text no longer than {@link #TEXT_LIMIT} either way. */
  public static byte[] utf8(String text) throws CharacterCodingException {
    if (text == null || text.length() > TEXT_LIMIT)
      throw new IllegalArgumentException("Text outside export limits");
    ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
                             .onMalformedInput(CodingErrorAction.REPORT)
                             .onUnmappableCharacter(CodingErrorAction.REPORT)
                             .encode(CharBuffer.wrap(text));
    if (encoded.remaining() > TEXT_LIMIT)
      throw new IllegalArgumentException("Text outside export limits");
    byte[] value = new byte[encoded.remaining()];
    encoded.get(value);
    return value;
  }

  /**
   * A destination title: path separators and control characters become {@code _}, the result is
   * cut to {@link #TITLE_LIMIT} characters, and a blank title becomes the fallback.
   */
  public static String title(String title, String fallback) {
    String value = (title == null ? fallback : title).replaceAll("[\\\\/\\p{Cntrl}]", "_");
    if (value.length() > TITLE_LIMIT)
      value = value.substring(0, TITLE_LIMIT);
    return value.isBlank() ? fallback : value;
  }

  /** Reads at most {@code limit} bytes and requires them to equal {@code expected} exactly. */
  public static void verify(InputStream in, byte[] expected, int limit) throws IOException {
    if (in == null)
      throw new IOException("Missing readback");
    ByteArrayOutputStream copy = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int n;
    while ((n = in.read(buffer)) != -1) {
      if (copy.size() + n > limit)
        throw new IOException("Readback exceeds export limits");
      copy.write(buffer, 0, n);
    }
    if (!Arrays.equals(expected, copy.toByteArray()))
      throw new IOException("Readback bytes changed");
  }

  /** The outcome of a write that threw, given whether the destination had been opened. */
  public static Outcome failed(boolean opened) {
    return opened ? Outcome.UNVERIFIED : Outcome.FAILED;
  }

  /** A single relative path segment: letters, digits, dot, dash and underscore. */
  public static boolean validSegment(String value) {
    return value != null && value.matches("[A-Za-z0-9._-]{1,64}") && !value.equals(".")
        && !value.equals("..");
  }

  /** True for exactly {@code [pathName, <file>]} with a non-empty file segment. */
  public static boolean handoffPath(List<String> segments, String pathName) {
    return segments != null && segments.size() == 2 && pathName.equals(segments.get(0))
        && segments.get(1) != null && !segments.get(1).isEmpty();
  }
}

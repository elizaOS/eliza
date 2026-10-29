package ai.eliza.plugins.media;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Android document-provider intents and verified writes for explicit, owner-chosen import and
 * export. No broad storage permission, no remembered destination and no network: each export
 * writes once to the document Android's picker returned and reads it back.
 */
public final class DocumentDestinations {
  private DocumentDestinations() {}

  /** Android's "save as" picker for one new document of this type and file name. */
  public static Intent create(String mimeType, String fileName) {
    return new Intent(Intent.ACTION_CREATE_DOCUMENT)
        .setType(mimeType)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .putExtra(Intent.EXTRA_TITLE, fileName)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
  }

  /** Android's document picker for one transient, read-only selection of this type. */
  public static Intent open(String mimeType) {
    return new Intent(Intent.ACTION_OPEN_DOCUMENT)
        .setType(mimeType)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
  }

  /** True for a document URI a provider returned (content scheme only). */
  public static boolean admits(Uri uri) {
    return uri != null && "content".equals(uri.getScheme());
  }

  /**
   * Truncates and writes the exact bytes, then reads them back. Every failure after the provider
   * opened the destination is {@link DocumentExport.Outcome#UNVERIFIED}, never "failed": the
   * provider may hold some or all bytes.
   */
  public static DocumentExport.Outcome write(ContentResolver resolver, Uri uri, byte[] content) {
    return write(resolver, uri, content, () -> {});
  }

  /** A host check that throws once the operation was cancelled or its review closed. */
  public interface Guard {
    void check() throws Exception;
  }

  /**
   * As {@link #write(ContentResolver, Uri, byte[])}, checking the guard after the destination
   * opens, before the bytes are written and before success is reported.
   */
  public static DocumentExport.Outcome write(
      ContentResolver resolver, Uri uri, byte[] content, Guard guard) {
    boolean opened = false;
    try {
      try (OutputStream out = resolver.openOutputStream(uri, "wt")) {
        if (out == null)
          throw new IOException("Destination unavailable");
        opened = true;
        guard.check();
        out.write(content);
        out.flush();
      }
      try (InputStream in = resolver.openInputStream(uri)) {
        DocumentExport.verify(in, content, content.length);
      }
      guard.check();
      return DocumentExport.Outcome.EXPORTED;
    } catch (Exception | OutOfMemoryError failure) {
      return DocumentExport.failed(opened);
    }
  }
}

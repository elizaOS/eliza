// spec/os/android/files/storage.md, "A listing or folder walk shows dot entries only when asked, and never the Trash under any spelling"
package android.webkit;

public final class MimeTypeMap {
  private static final MimeTypeMap SINGLETON = new MimeTypeMap();

  private MimeTypeMap() {}

  public static MimeTypeMap getSingleton() {
    return SINGLETON;
  }

  public String getMimeTypeFromExtension(String extension) {
    return null;
  }
}

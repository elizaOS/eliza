package ai.eliza.plugins.media;

/**
 * Which selection's read-only PDF copy is kept between page renders, and the provider's size and
 * last-modified time when it was copied. A copy is reused only for the same selection while the
 * provider still reports the same size and time and the file still has that size; a provider that
 * reports neither gets a fresh copy for every page. One copy at most is kept.
 */
final class PdfSourceCopy {
  private String id;
  private long size = -1, modified = -1;

  /** True when the kept copy is still the source of selection {@code id}. */
  boolean reusable(String id, long size, long modified, long copyLength) {
    return this.id != null && this.id.equals(id) && known(size, modified) && size == this.size
        && modified == this.modified && copyLength == size;
  }

  /** Records a completed copy; an unknown source stamp keeps nothing. */
  void kept(String id, long size, long modified) {
    if (!known(size, modified)) {
      clear();
      return;
    }
    this.id = id;
    this.size = size;
    this.modified = modified;
  }

  /** The selection whose copy is kept, or null. */
  String id() {
    return id;
  }

  void clear() {
    id = null;
    size = -1;
    modified = -1;
  }

  private static boolean known(long size, long modified) {
    return size > 0 && modified > 0;
  }
}

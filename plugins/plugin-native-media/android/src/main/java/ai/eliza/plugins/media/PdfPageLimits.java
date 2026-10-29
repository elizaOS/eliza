package ai.eliza.plugins.media;

/**
 * Bounds shared by the isolated PDF renderer ({@link IsolatedPdfRenderService}) and the viewer
 * that displays its pixels ({@link IsolatedPdfViewerActivity}). The renderer fits each page inside
 * these limits; the viewer refuses any reply that was not produced by a separate, isolated,
 * network-denied process inside the same limits. Pure Java; no Android types.
 */
public final class PdfPageLimits {
  /** Largest rendered page, in pixels. */
  public static final int MAX_PIXELS = 1_500_000;
  /** Largest page count the renderer opens. */
  public static final int MAX_PAGES = 500;
  /** Largest PDF the renderer parses. */
  public static final long MAX_SOURCE_BYTES = 5L * 1024 * 1024;
  /** Rendered width bound (portrait reading width). */
  public static final int MAX_WIDTH = 1024;
  /** Rendered height bound, and the largest edge a viewer accepts in either direction. */
  public static final int MAX_EDGE = 1536;
  /** Largest page edge in PDF points the renderer accepts. */
  public static final int MAX_PAGE_POINTS = 20000;
  /** The renderer process ends itself when one page takes longer than this. */
  public static final int DEADLINE_MS = 10000;
  /** The viewer gives up slightly after the renderer's own deadline. */
  public static final int VIEWER_TIMEOUT_MS = 12000;
  /** Proportional set size (KiB) above which the renderer process ends itself. */
  public static final long MAX_RENDERER_PSS_KB = 128L * 1024;
  /** Length of a request identity (a random UUID string). */
  public static final int REQUEST_LENGTH = 36;

  private PdfPageLimits() {}

  /** True for a request the renderer may start: a UUID-length identity and a page in range. */
  public static boolean admitsRequest(String request, int page) {
    return request != null && request.length() == REQUEST_LENGTH && page >= 0 && page < MAX_PAGES;
  }

  /** Refuses an empty or oversized PDF before it is parsed. */
  public static void requireSource(long size) {
    if (size <= 0 || size > MAX_SOURCE_BYTES)
      throw new IllegalArgumentException("PDF size outside viewer limits");
  }

  /** Refuses a page count or index outside the limits. */
  public static void requirePage(int count, int index) {
    if (count < 1 || count > MAX_PAGES || index < 0 || index >= count)
      throw new IllegalArgumentException("PDF page outside viewer limits");
  }

  /**
   * The rendered size of a page measured in PDF points: at most {@link #MAX_WIDTH} wide,
   * {@link #MAX_EDGE} tall and {@link #MAX_PIXELS} in area, keeping the aspect ratio.
   *
   * @return {width, height}
   */
  public static int[] fit(int pageWidth, int pageHeight) {
    if (pageWidth < 1 || pageHeight < 1 || pageWidth > MAX_PAGE_POINTS
        || pageHeight > MAX_PAGE_POINTS)
      throw new IllegalArgumentException("PDF page size outside viewer limits");
    double scale = Math.min(
        Math.min((double) MAX_WIDTH / pageWidth, (double) MAX_EDGE / pageHeight),
        Math.sqrt(MAX_PIXELS / ((double) pageWidth * pageHeight)));
    int width = Math.max(1, (int) Math.floor(pageWidth * scale));
    int height = Math.max(1, (int) Math.floor(pageHeight * scale));
    if ((long) width * height > MAX_PIXELS)
      throw new IllegalArgumentException("PDF page size outside viewer limits");
    return new int[] {width, height};
  }

  /** Byte length of an ARGB_8888 page of this size; overflow is refused. */
  public static int argbLength(int width, int height) {
    return Math.multiplyExact(Math.multiplyExact(width, height), 4);
  }

  /**
   * Checks a renderer reply before any pixel is mapped. The reply must come from an isolated,
   * network-denied process with a different uid, for the page the viewer asked for, within the
   * size limits, with exactly the ARGB bytes the size names.
   */
  public static void requireReply(boolean isolated, boolean internetDenied, int rendererUid,
      int viewerUid, int width, int height, int pages, int page, int expectedPage,
      long pixelBytes) {
    if (!isolated || !internetDenied || rendererUid == viewerUid || width < 1 || height < 1
        || width > MAX_EDGE || height > MAX_EDGE || (long) width * height > MAX_PIXELS
        || pages < 1 || pages > MAX_PAGES || page != expectedPage || expectedPage < 0
        || expectedPage >= pages || pixelBytes != (long) width * height * 4)
      throw new IllegalArgumentException("PDF renderer reply refused");
  }
}

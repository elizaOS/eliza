package ai.eliza.plugins.media;

import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.RemoteException;
import android.os.SharedMemory;
import android.system.OsConstants;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Untrusted PDF parsing confined to a permissionless isolated process. The host declares a
 * concrete subclass in its manifest with {@code android:isolatedProcess="true"},
 * {@code android:exported="false"} and its own {@code android:process}; this library declares no
 * component. The service renders one page at a time from a read-only descriptor the viewer sends,
 * into read-only shared memory, and ends its own process past {@link PdfPageLimits#DEADLINE_MS}
 * or {@link PdfPageLimits#MAX_RENDERER_PSS_KB}. Outside an isolated process it refuses to bind.
 *
 * <p>Wire format (Messenger, {@code what == 1}): request bundle {@code request} (UUID string),
 * {@code page} (0-based) and {@code descriptor}; reply bundle {@code request} and either
 * {@code error}, or {@code pixels} (SharedMemory, ARGB_8888), {@code width}, {@code height},
 * {@code pages}, {@code page}, {@code uid}, {@code isolated} and {@code internetDenied}.
 */
public abstract class IsolatedPdfRenderService extends Service {
  public static final int MESSAGE = 1;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final AtomicBoolean busy = new AtomicBoolean();
  private final Runnable kill = () -> {
    if (Process.isIsolated())
      Process.killProcess(Process.myPid());
  };
  private final Runnable memory = new Runnable() {
    @Override public void run() {
      if (!busy.get())
        return;
      if (Debug.getPss() > PdfPageLimits.MAX_RENDERER_PSS_KB) {
        kill.run();
        return;
      }
      main.postDelayed(this, 250);
    }
  };
  private final Messenger endpoint = new Messenger(new Handler(Looper.getMainLooper(), message -> {
    if (message.what != MESSAGE || message.replyTo == null)
      return true;
    Bundle data = message.getData();
    ParcelFileDescriptor descriptor = data.getParcelable("descriptor");
    String request = data.getString("request", "");
    int page = data.getInt("page", -1);
    Messenger reply = message.replyTo;
    if (!Process.isIsolated() || descriptor == null || !PdfPageLimits.admitsRequest(request, page)
        || !busy.compareAndSet(false, true)) {
      close(descriptor);
      error(reply, request, "PDF request unavailable");
      return true;
    }
    main.postDelayed(kill, PdfPageLimits.DEADLINE_MS);
    main.post(memory);
    boolean stall = stallFixture(data);
    worker.execute(() -> render(descriptor, page, request, reply, stall));
    return true;
  }));

  /**
   * Development hosts may return true for a request carrying their watchdog fixture, so the
   * deadline can be exercised. Release hosts keep the default: no request can stall rendering.
   */
  protected boolean stallFixture(Bundle request) {
    return false;
  }

  /** Message shown when a page cannot be rendered within the limits. */
  protected String renderFailureMessage() {
    return "PDF is corrupt, password protected, expired, or exceeds viewer limits.";
  }

  @Override public IBinder onBind(Intent intent) {
    return Process.isIsolated() ? endpoint.getBinder() : null;
  }

  private static void close(ParcelFileDescriptor descriptor) {
    if (descriptor != null)
      try {
        descriptor.close();
      } catch (Exception ignored) {
      }
  }

  private static void send(Messenger target, Bundle bundle) throws RemoteException {
    Message message = Message.obtain(null, MESSAGE);
    message.setData(bundle);
    target.send(message);
  }

  private static void error(Messenger target, String request, String text) {
    try {
      Bundle result = new Bundle();
      result.putString("request", request);
      result.putString("error", text);
      send(target, result);
    } catch (Exception ignored) {
    }
  }

  private void render(ParcelFileDescriptor descriptor, int index, String request, Messenger reply,
      boolean stall) {
    Bitmap bitmap = null;
    SharedMemory shared = null;
    ByteBuffer mapping = null;
    Bundle completed = null;
    try {
      if (stall)
        Thread.sleep(PdfPageLimits.DEADLINE_MS + 5000L);
      PdfPageLimits.requireSource(descriptor.getStatSize());
      try (PdfRenderer renderer = new PdfRenderer(descriptor)) {
        int count = renderer.getPageCount();
        PdfPageLimits.requirePage(count, index);
        try (PdfRenderer.Page page = renderer.openPage(index)) {
          int pw = page.getWidth(), ph = page.getHeight();
          int[] size = PdfPageLimits.fit(pw, ph);
          int width = size[0], height = size[1];
          bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
          bitmap.eraseColor(Color.WHITE);
          Matrix transform = new Matrix();
          transform.setScale(width / (float) pw, height / (float) ph);
          page.render(bitmap, null, transform, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
          int length = PdfPageLimits.argbLength(width, height);
          if (bitmap.getByteCount() != length)
            throw new IllegalStateException();
          shared = SharedMemory.create("reviewed-pdf-page", length);
          mapping = shared.mapReadWrite();
          bitmap.copyPixelsToBuffer(mapping);
          SharedMemory.unmap(mapping);
          mapping = null;
          if (!shared.setProtect(OsConstants.PROT_READ))
            throw new IllegalStateException();
          Bundle result = new Bundle();
          result.putString("request", request);
          result.putParcelable("pixels", shared);
          result.putInt("width", width);
          result.putInt("height", height);
          result.putInt("pages", count);
          result.putInt("page", index);
          result.putInt("uid", Process.myUid());
          result.putBoolean("isolated", Process.isIsolated());
          result.putBoolean("internetDenied",
              checkSelfPermission(android.Manifest.permission.INTERNET)
                  == PackageManager.PERMISSION_DENIED);
          completed = result;
        }
      }
    } catch (Exception | OutOfMemoryError failure) {
      completed = null;
    } finally {
      if (mapping != null)
        SharedMemory.unmap(mapping);
      if (bitmap != null)
        bitmap.recycle();
      close(descriptor);
      Bundle result = completed;
      SharedMemory output = shared;
      main.post(() -> {
        main.removeCallbacks(kill);
        main.removeCallbacks(memory);
        busy.set(false);
        try {
          if (result == null)
            error(reply, request, renderFailureMessage());
          else
            send(reply, result);
        } catch (Exception ignored) {
        } finally {
          if (output != null)
            output.close();
        }
      });
    }
  }

  @Override public boolean onUnbind(Intent intent) {
    kill.run();
    return false;
  }

  @Override public void onDestroy() {
    worker.shutdownNow();
    kill.run();
    super.onDestroy();
  }
}

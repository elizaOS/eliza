package ai.eliza.plugins.media;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.*;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Native, one-shot review of a favorite, Recently deleted or permanent-removal change to 1–20
 * permitted library items. The owner confirms a native dialog naming every item, then Android's own
 * MediaStore write request; the change is applied only to the reviewed revisions after the activity
 * resumes. Activity recreation discards authority; it never replays a write.
 */
public final class PermittedMediaReview implements AutoCloseable {
  /** Launches an activity request. False, after rejecting the call, when the launcher is gone. */
  public interface LaunchGate {
    boolean ask(PluginCall call, Runnable launch);
  }
  /**
   * Capacitor can deliver a call made just before the activity was destroyed after androidx has
   * unregistered every launcher; launch() then throws IllegalStateException on the bridge thread.
   * The request is rejected instead of ending the process.
   */
  public static final LaunchGate REJECT_WHEN_CLOSED = (call, launch) -> {
    try {
      launch.run();
      return true;
    } catch (IllegalStateException closed) {
      call.reject(
          "Android could not show this request; the app may have closed. Reopen it and try again.");
      return false;
    }
  };
  private final Bridge bridge;
  private final PermittedMediaCatalog catalog;
  private final Executor worker;
  private final LaunchGate gate;
  private final ActivityResultLauncher<IntentSenderRequest> launcher;
  private final AtomicReference<Request> pending = new AtomicReference<>();
  private volatile boolean closed;
  private static final class Request {
    final PluginCall call;
    final List<String> ids, revisions;
    final boolean favorite, desired, batch, permanent;
    final long until = SystemClock.elapsedRealtime() + 120000;
    Request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
        boolean desired, boolean batch, boolean permanent) {
      this.call = call;
      this.ids = List.copyOf(ids);
      this.revisions = List.copyOf(revisions);
      this.favorite = favorite;
      this.desired = desired;
      this.batch = batch;
      this.permanent = permanent;
    }
  }
  public PermittedMediaReview(Bridge bridge, PermittedMediaCatalog catalog, Executor worker) {
    this(bridge, catalog, worker, REJECT_WHEN_CLOSED);
  }
  public PermittedMediaReview(
      Bridge bridge, PermittedMediaCatalog catalog, Executor worker, LaunchGate gate) {
    this.bridge = bridge;
    this.catalog = catalog;
    this.worker = worker;
    this.gate = gate;
    launcher = bridge.registerForActivityResult(
        new ActivityResultContracts.StartIntentSenderForResult(), result -> {
          Request request = pending.getAndSet(null);
          if (request == null)
            return;
          if (closed || result.getResultCode() != Activity.RESULT_OK
              || request.until < SystemClock.elapsedRealtime()) {
            request.call.reject(
                "Photo change cancelled or expired. No change was dispatched.", DECLINED);
            return;
          }
          afterResume(request);
        });
  }
  /**
   * Android delivers the write-request result before the activity resumes, while the catalog is
   * still marked background (its plugin's handleOnResume has not run). Applying then would fail the
   * foreground check and report an approved change as unverified, so dispatch waits for RESUMED.
   */
  private void afterResume(Request request) {
    androidx.lifecycle.Lifecycle lifecycle = bridge.getActivity().getLifecycle();
    if (lifecycle.getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
      dispatch(request);
      return;
    }
    lifecycle.addObserver(new androidx.lifecycle.LifecycleEventObserver() {
      @Override
      public void onStateChanged(
          androidx.lifecycle.LifecycleOwner owner, androidx.lifecycle.Lifecycle.Event event) {
        if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
          owner.getLifecycle().removeObserver(this);
          if (closed || request.until < SystemClock.elapsedRealtime())
            request.call.reject(
                "Photo change cancelled or expired. No change was dispatched.", DECLINED);
          else
            dispatch(request);
        } else if (event == androidx.lifecycle.Lifecycle.Event.ON_DESTROY) {
          owner.getLifecycle().removeObserver(this);
          request.call.reject("Photos closed before dispatch. Review the selection again.");
        }
      }
    });
  }
  private void dispatch(Request request) {
    try {
      worker.execute(() -> apply(request));
    } catch (RuntimeException unavailable) {
      request.call.reject("Photos closed before dispatch. Review the selection again.");
    }
  }
  public void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch) {
    request(call, ids, revisions, favorite, desired, batch, false);
  }
  public void deleteTrashed(PluginCall call, List<String> ids, List<String> revisions) {
    request(call, ids, revisions, false, true, true, true);
  }
  private void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch, boolean permanent) {
    Request request = new Request(call, ids, revisions, favorite, desired, batch, permanent);
    if (closed || Build.VERSION.SDK_INT < 30 || ids.isEmpty() || ids.size() > 20
        || new HashSet<>(ids).size() != ids.size() || ids.size() != revisions.size()) {
      call.reject("Select 1–20 distinct permitted items.");
      return;
    }
    if (!pending.compareAndSet(null, request)) {
      call.reject("Finish the current photo review first.", "LIBRARY_BUSY");
      return;
    }
    try {
      List<Uri> uris = new ArrayList<>();
      StringBuilder names = new StringBuilder();
      for (int i = 0; i < ids.size(); i++) {
        JSObject row = catalog.mutationSource(ids.get(i), revisions.get(i));
        if (favorite && Boolean.TRUE.equals(row.getBoolean("trashed"))
            || permanent && !Boolean.TRUE.equals(row.getBoolean("trashed")))
          throw new IllegalStateException();
        uris.add(catalog.uri(MediaLibraryKey.parse(ids.get(i))));
        names.append(i + 1)
            .append(". ")
            .append(row.getString("name").replaceAll("[\\p{Cntrl}]", " "))
            .append('\n');
      }
      android.app.PendingIntent grant =
          MediaStore.createWriteRequest(bridge.getContext().getContentResolver(), uris);
      bridge.getActivity().runOnUiThread(() -> {
        if (closed || pending.get() != request || !bridge.getActivity().hasWindowFocus()
            || request.until < SystemClock.elapsedRealtime()) {
          cancel(request, "Return to Photos to review this change.", DECLINED);
          return;
        }
        String action = permanent ? "Delete forever"
            : favorite            ? (desired ? "Favorite" : "Unfavorite")
                                  : (desired ? "Move to Recently deleted" : "Restore");
        new AlertDialog.Builder(bridge.getActivity())
            .setTitle(action + " " + ids.size() + " item" + (ids.size() == 1 ? "" : "s") + "?")
            .setMessage(names
                + (permanent ? "\nThese items will be permanently deleted and cannot be recovered. "
                               + "Android will ask for access. Items restored or changed elsewhere "
                               + "will be skipped."
                             : "\nAndroid will ask for access. Only these selected revisions will "
                               + "be changed; items changed elsewhere will be skipped."))
            .setNegativeButton("Cancel",
                (dialog, which)
                    -> cancel(
                        request, "Photo change cancelled. No change was dispatched.", DECLINED))
            .setOnCancelListener(dialog
                -> cancel(request, "Photo change cancelled. No change was dispatched.", DECLINED))
            .setPositiveButton(permanent ? "Delete forever" : "Continue",
                (dialog, which) -> {
                  if (closed || pending.get() != request
                      || request.until < SystemClock.elapsedRealtime()) {
                    cancel(request, "Photo review expired.", DECLINED);
                    return;
                  }
                  if (!gate.ask(call,
                          ()
                              -> launcher.launch(
                                  new IntentSenderRequest.Builder(grant.getIntentSender())
                                      .build())))
                    pending.compareAndSet(request, null);
                })
            .show();
      });
    } catch (Exception unavailable) {
      cancel(request, "Selected media changed or is unavailable. Refresh Photos.", STALE);
    }
  }
  /**
   * Error codes: nothing was dispatched because the owner or Android declined, or because a
   * selected revision changed.
   */
  public static final String DECLINED = "LIBRARY_DECLINED", STALE = "LIBRARY_STALE";
  private void cancel(Request request, String reason, String code) {
    if (pending.compareAndSet(request, null))
      request.call.reject(reason, code);
  }
  private void apply(Request request) {
    JSArray outcomes = new JSArray();
    int verified = 0;
    for (int i = 0; i < request.ids.size(); i++) {
      JSObject outcome = new JSObject();
      outcome.put("id", request.ids.get(i));
      try {
        if (closed || request.until < SystemClock.elapsedRealtime())
          throw new IllegalStateException("unverified");
        JSObject row = request.permanent
            ? catalog.deleteTrashed(request.ids.get(i), request.revisions.get(i))
            : catalog.changeFlag(
                  request.ids.get(i), request.revisions.get(i), request.favorite, request.desired);
        outcome.put("status", row.getString("status"));
        outcome.put("item", row);
        verified++;
      } catch (Exception failure) {
        outcome.put("status", "stale".equals(failure.getMessage()) ? "stale" : "unverified");
      }
      outcomes.put(outcome);
    }
    try {
      if (!request.batch) {
        JSObject outcome = JSObject.fromJSONObject(outcomes.getJSONObject(0));
        if (verified == 1)
          request.call.resolve(JSObject.fromJSONObject(outcome.getJSONObject("item")));
        else
          request.call.reject(
              "Photo outcome could not be verified. Refresh before reviewing a new change.");
      } else {
        JSObject result = new JSObject();
        result.put("status", verified == request.ids.size() ? "complete" : "partial");
        result.put("outcomes", outcomes);
        request.call.resolve(result);
      }
    } catch (Exception invalid) {
      request.call.reject("Photo outcome could not be verified. Refresh Photos.");
    }
  }
  @Override
  public void close() {
    closed = true;
    Request request = pending.getAndSet(null);
    if (request != null)
      request.call.reject("Photos closed. No reviewed change will be replayed.");
    launcher.unregister();
  }
}

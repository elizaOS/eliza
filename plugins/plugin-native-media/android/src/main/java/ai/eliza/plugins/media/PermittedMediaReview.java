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
import java.util.function.Consumer;

/**
 * Native, one-shot review of a favorite, Recently deleted or permanent-removal change to 1–20
 * permitted library items. An owner's favorite, unfavorite, trash or restore goes straight to
 * Android's own favorite or trash request, which names the action and the items, and Android
 * applies it. Permanent removal and agent requests first show a native dialog naming every item,
 * then Android's write request, and the change is applied only to the reviewed revisions after the
 * activity resumes. Every request checks the selected revisions before Android is asked. Activity
 * recreation discards authority; it never replays a write.
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
    final boolean favorite, desired, batch, permanent, appReview;
    /** A batch's continuation: receives the outcomes instead of resolving the call. */
    Consumer<JSArray> then;
    /** Identity and flag of each item when Android was asked; read back after Android applies. */
    final List<String> identities = new ArrayList<>();
    final List<Boolean> before = new ArrayList<>();
    final long until = SystemClock.elapsedRealtime() + 120000;
    Request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
        boolean desired, boolean batch, boolean permanent, boolean agent) {
      this.call = call;
      this.ids = List.copyOf(ids);
      this.revisions = List.copyOf(revisions);
      this.favorite = favorite;
      this.desired = desired;
      this.batch = batch;
      this.permanent = permanent;
      this.appReview = PermittedMediaChange.appReview(permanent, agent);
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
          if (result.getResultCode() != Activity.RESULT_OK) {
            request.call.reject(
                "Photo change cancelled or expired. No change was dispatched.", DECLINED);
            return;
          }
          if (closed || expired(request)) {
            unconfirmed(request);
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
          if (closed || expired(request))
            unconfirmed(request);
          else
            dispatch(request);
        } else if (event == androidx.lifecycle.Lifecycle.Event.ON_DESTROY) {
          owner.getLifecycle().removeObserver(this);
          if (request.appReview)
            request.call.reject("Photos closed before dispatch. Review the selection again.");
          else
            unconfirmed(request);
        }
      }
    });
  }
  /**
   * Expiry ends the authority to write. Android has already applied an owner's own change, so only
   * its readback remains and it never expires.
   */
  private static boolean expired(Request request) {
    return request.appReview && request.until < SystemClock.elapsedRealtime();
  }
  /** An approved change that will not be applied or read back here. */
  private static void unconfirmed(Request request) {
    if (request.appReview)
      request.call.reject("Photo change cancelled or expired. No change was dispatched.", DECLINED);
    else
      request.call.reject("Photo outcome could not be verified. Refresh Photos.");
  }
  private void dispatch(Request request) {
    try {
      worker.execute(() -> apply(request));
    } catch (RuntimeException unavailable) {
      if (request.appReview)
        request.call.reject("Photos closed before dispatch. Review the selection again.");
      else
        unconfirmed(request);
    }
  }
  /** A change the agent asked for: the owner sees the app's review before Android's. */
  public void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch) {
    request(call, ids, revisions, favorite, desired, batch, true);
  }
  /** {@code agent} false: the owner's own change in Photos, reviewed only by Android. */
  public void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch, boolean agent) {
    request(call, ids, revisions, favorite, desired, batch, false, agent);
  }
  /**
   * A batch whose call settles in {@code then}: it receives the per-item outcomes once Android's
   * review completes, while a decline, stale selection or closed Photos still rejects the call.
   */
  public void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean agent, Consumer<JSArray> then) {
    request(call, ids, revisions, favorite, desired, true, false, agent, then);
  }
  public void deleteTrashed(PluginCall call, List<String> ids, List<String> revisions) {
    request(call, ids, revisions, false, true, true, true, false);
  }
  private void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch, boolean permanent, boolean agent) {
    request(call, ids, revisions, favorite, desired, batch, permanent, agent, null);
  }
  private void request(PluginCall call, List<String> ids, List<String> revisions, boolean favorite,
      boolean desired, boolean batch, boolean permanent, boolean agent, Consumer<JSArray> then) {
    Request request =
        new Request(call, ids, revisions, favorite, desired, batch, permanent, agent);
    request.then = then;
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
        request.identities.add(row.getString("identity"));
        request.before.add(Boolean.TRUE.equals(row.getBoolean(favorite ? "favorite" : "trashed")));
        uris.add(catalog.uri(MediaLibraryKey.parse(ids.get(i))));
        names.append(i + 1)
            .append(". ")
            .append(row.getString("name").replaceAll("[\\p{Cntrl}]", " "))
            .append('\n');
      }
      android.content.ContentResolver resolver = bridge.getContext().getContentResolver();
      // Android's favorite and trash requests apply the change themselves once the owner allows it.
      android.app.PendingIntent grant = request.appReview
          ? MediaStore.createWriteRequest(resolver, uris)
          : favorite ? MediaStore.createFavoriteRequest(resolver, uris, desired)
                     : MediaStore.createTrashRequest(resolver, uris, desired);
      bridge.getActivity().runOnUiThread(() -> {
        if (closed || pending.get() != request || !bridge.getActivity().hasWindowFocus()
            || request.until < SystemClock.elapsedRealtime()) {
          cancel(request, "Return to Photos to review this change.", DECLINED);
          return;
        }
        if (!request.appReview) {
          launch(request, grant);
          return;
        }
        new AlertDialog.Builder(bridge.getActivity())
            .setTitle(PermittedMediaChange.title(ids.size(), favorite, desired, permanent))
            .setMessage(PermittedMediaChange.message(names.toString(), permanent))
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
                  launch(request, grant);
                })
            .show();
      });
    } catch (Exception unavailable) {
      cancel(request, "Selected media changed or is unavailable. Refresh Photos.", STALE);
    }
  }
  private void launch(Request request, android.app.PendingIntent grant) {
    PluginCall call = request.call;
    if (!gate.ask(call,
            ()
                -> launcher.launch(
                    new IntentSenderRequest.Builder(grant.getIntentSender()).build())))
      pending.compareAndSet(request, null);
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
        if (closed || expired(request))
          throw new IllegalStateException("unverified");
        JSObject row = request.permanent
            ? catalog.deleteTrashed(request.ids.get(i), request.revisions.get(i))
            : !request.appReview
            ? catalog.confirmFlag(request.ids.get(i), request.identities.get(i), request.favorite,
                  request.desired, request.before.get(i))
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
      } else if (request.then != null) {
        request.then.accept(outcomes);
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

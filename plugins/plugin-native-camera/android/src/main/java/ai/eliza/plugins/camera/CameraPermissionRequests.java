package ai.eliza.plugins.camera;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/** Pending camera-only callbacks, confined to the plugin's existing main-thread lifecycle. */
final class CameraPermissionRequests<T> {
  interface Host<T> {
    void request(String alias, T call);
    void resolve(T call);
    void rejectClosed(T call);
    void rejectFailure(T call, RuntimeException error);
  }

  private final Host<T> host;
  private final Set<T> pending = Collections.newSetFromMap(new IdentityHashMap<>());
  private boolean closed;

  CameraPermissionRequests(Host<T> host) {
    this.host = host;
  }

  void request(T call) {
    if (closed) {
      host.rejectClosed(call);
      return;
    }
    if (!pending.add(call)) return;
    try {
      host.request("camera", call);
    } catch (RuntimeException error) {
      if (pending.remove(call)) host.rejectFailure(call, error);
    }
  }

  void complete(T call) {
    if (pending.remove(call)) host.resolve(call);
  }

  void close() {
    closed = true;
    ArrayList<T> retired = new ArrayList<>(pending);
    pending.clear();
    for (T call : retired) host.rejectClosed(call);
  }
}

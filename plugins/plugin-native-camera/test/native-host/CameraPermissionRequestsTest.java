package ai.eliza.plugins.camera;

import java.util.ArrayList;
import java.util.List;

public final class CameraPermissionRequestsTest {
  private static final class Host implements CameraPermissionRequests.Host<Object> {
    final List<String> calls = new ArrayList<>();
    Runnable dispatch;
    @Override public void request(String alias, Object call) {
      calls.add("request:" + alias);
      if (dispatch != null) dispatch.run();
    }
    @Override public void resolve(Object call) { calls.add("resolved"); }
    @Override public void rejectClosed(Object call) { calls.add("closed"); }
    @Override public void rejectFailure(Object call, RuntimeException error) { calls.add("failed"); }
  }

  private static void equal(List<String> actual, String... expected) {
    if (!actual.equals(List.of(expected))) throw new AssertionError(actual + " != " + List.of(expected));
  }

  public static void main(String[] args) {
    Host host = new Host();
    CameraPermissionRequests<Object> requests = new CameraPermissionRequests<>(host);
    Object first = new Object(), second = new Object(), afterClose = new Object();
    requests.request(first);
    requests.request(first);
    equal(host.calls, "request:camera");
    requests.complete(new Object());
    equal(host.calls, "request:camera");
    requests.complete(first);
    requests.complete(first);
    equal(host.calls, "request:camera", "resolved");
    requests.request(second);
    requests.close();
    requests.close();
    requests.complete(second);
    requests.request(afterClose);
    equal(host.calls, "request:camera", "resolved", "request:camera", "closed", "closed");

    Host failed = new Host();
    CameraPermissionRequests<Object> failing = new CameraPermissionRequests<>(failed);
    failed.dispatch = () -> { throw new IllegalStateException("dispatch failed"); };
    failing.request(first);
    failing.complete(first);
    equal(failed.calls, "request:camera", "failed");

    Host synchronous = new Host();
    CameraPermissionRequests<Object> inline = new CameraPermissionRequests<>(synchronous);
    synchronous.dispatch = () -> {
      inline.complete(first);
      throw new IllegalStateException("after completion");
    };
    inline.request(first);
    inline.close();
    equal(synchronous.calls, "request:camera", "resolved");
    System.out.println("PASS exact camera alias, identity, completion, close and late callback");
  }
}

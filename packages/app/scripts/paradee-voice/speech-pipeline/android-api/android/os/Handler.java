package android.os;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Test double: every handler posts to one serial daemon thread, as to Android's main thread. */
public class Handler {
    private static final ExecutorService MAIN = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "test-main");
        thread.setDaemon(true);
        return thread;
    });

    public Handler(Looper looper) {}

    public boolean post(Runnable task) {
        MAIN.execute(task);
        return true;
    }
}

/**
 * Serializes interactive notification refreshes away from Android lifecycle
 * threads while retaining one replay when state changes during an update.
 */
package ai.elizaos.app;

import java.util.Objects;

final class LatestNotificationUpdateWorker {
    private final Object lock = new Object();
    private final String threadName;
    private final Runnable update;
    private boolean requested;
    private Thread worker;

    LatestNotificationUpdateWorker(String threadName, Runnable update) {
        this.threadName = Objects.requireNonNull(threadName, "threadName");
        this.update = Objects.requireNonNull(update, "update");
    }

    void request() {
        synchronized (lock) {
            requested = true;
            if (worker == null) {
                startWorkerLocked();
            }
        }
    }

    private boolean takeRequest() {
        synchronized (lock) {
            if (!requested) {
                return false;
            }
            requested = false;
            return true;
        }
    }

    private void startWorkerLocked() {
        Thread nextWorker = new Thread(this::drain, threadName);
        worker = nextWorker;
        try {
            nextWorker.start();
        } catch (RuntimeException | Error error) {
            worker = null;
            throw error;
        }
    }

    private void drain() {
        try {
            while (takeRequest()) {
                update.run();
            }
        } finally {
            synchronized (lock) {
                worker = null;
                if (requested) {
                    startWorkerLocked();
                }
            }
        }
    }
}

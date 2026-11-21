import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("planned Android runtime stops use the status channel and actual failures use alerts", () => {
  const source = readFileSync(new URL(
    "../../platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java",
    import.meta.url,
  ), "utf8");
  const start = source.indexOf("    private void pushNotification() {");
  const end = source.indexOf("\n    /**", start);
  assert.ok(start >= 0 && end > start);
  const directory = mkdtempSync(join(tmpdir(), "runtime-notification-"));
  try {
    const java = join(directory, "RuntimeNotification.java");
    writeFileSync(java, `
public class RuntimeNotification {
    private static final String CHANNEL_ID = "status";
    private static final String RUNTIME_ALERT_CHANNEL_ID = "alerts";
    private static final int NOTIFICATION_ID = 1;
    private static class Context { static final String NOTIFICATION_SERVICE = "notification"; }
    private static class Notification {
        final String channelId;
        Notification(String channelId) {
            this.channelId = channelId;
        }
    }
    private static class NotificationManager {
        Notification posted;
        void notify(int id, Notification notice) { posted = notice; }
    }
    private final NotificationManager manager = new NotificationManager();
    private String currentStatus;
    private boolean terminalNoticePosted;
    private Object getSystemService(String name) { return manager; }
    private Notification buildNotification(String channelId, String title, String text, boolean ongoing) {
        return new Notification(channelId);
    }
${source.slice(start, end)}
    public static void main(String[] args) {
        RuntimeNotification service = new RuntimeNotification();
        for (String status : new String[]{"running", "starting", "restarting", "stopping", "stop-failed", "spawn-failed"}) {
            service.currentStatus = status;
            service.pushNotification();
            System.out.println(status + ":" + service.manager.posted.channelId);
        }
    }
}
`);
    execFileSync("javac", ["--release", "11", java], { stdio: "pipe" });
    const actual = execFileSync("java", ["-cp", directory, "RuntimeNotification"], { encoding: "utf8" });
    assert.deepEqual(actual.trim().split("\n"), [
      "running:status", "starting:status", "restarting:status", "stopping:status",
      "stop-failed:alerts", "spawn-failed:alerts",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

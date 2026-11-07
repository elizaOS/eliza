package ai.elizaos.app;

/** Exercises the production pure route policy, including privilege boundaries.
 * Token/owner/NMS effects are not simulated or claimed as physical acceptance. */
public final class NativeNotificationRouteTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError(); checks++; }
    public static void main(String[] args) {
        String id = "12345678-1234-1234-1234-123456789abc";
        for (String view : new String[]{"automations", "clock", "notes", "calendar", "reminders", "tasks"}) {
            String route = NativeNotificationRoute.uri("elizaos", "/" + view, id, id, id);
            check(route.equals("elizaos://" + ("tasks".equals(view) ? "apps/tasks" : view)));
            check(java.net.URI.create(route).getRawQuery() == null);
        }
        check(NativeNotificationRoute.uri("elizaos", "/apps/tasks", id, null, null).equals("elizaos://apps/tasks"));
        check(NativeNotificationRoute.uri("elizaos", "/chat", id, id, id).equals("elizaos://chat?notificationId=" + id + "&conversationId=" + id + "&messageId=" + id));
        check(NativeNotificationRoute.uri("elizaos", "/chat", id, "bad&command=delete", "bad").equals("elizaos://chat?notificationId=" + id));
        check(NativeNotificationRoute.uri("elizaos", "/chat", "bad", id, id) == null);
        for (String route : new String[]{"/connect", "/auth", "/share", "/first-run/runtime/remote", "/settings", "/browser", "/wallet", "/automations/task/id", "/clock/delete", "/notes?id=x", "/notes#delete", "//automations", "/automations/", "/%61utomations", "/notes\\delete", "https://example.com", "javascript:alert(1)", "elizaos://connect", " /automations", "/AUTOMATIONS"})
            check(NativeNotificationRoute.uri("elizaos", route, id, id, id) == null);
        for (String scheme : new String[]{"http", "https", "HTTP", "javascript", "file", "data", "content", "elizaos://connect", "bad scheme", ""})
            check(NativeNotificationRoute.uri(scheme, "/automations", id, id, id) == null);
        check(NativeNotificationRoute.uri(null, "/automations", id, null, null) == null);
        check(NativeNotificationRoute.uri("elizaos", null, id, null, null) == null);
        System.out.println("Native notification route policy passed: " + checks + " checks; no Android effects");
    }
}

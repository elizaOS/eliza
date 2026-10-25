package ai.elizaos.app;

/** Presentation-only notification routes. No producer URL, auth/runtime switch,
 * nested command or mutable component crosses this closed navigation policy. */
final class NativeNotificationRoute {
    static String view(String deepLink) {
        if (deepLink == null) return null;
        switch (deepLink) {
            case "/chat": return "chat";
            case "/automations": return "automations";
            case "/clock": return "clock";
            case "/notes": return "notes";
            case "/calendar": return "calendar";
            case "/reminders": return "reminders";
            case "/tasks":
            case "/apps/tasks": return "apps/tasks";
            default: return null;
        }
    }

    static String uri(String scheme, String deepLink, String notificationId, String conversationId, String messageId) {
        String view = view(deepLink);
        if (view == null || scheme == null || !scheme.matches("[A-Za-z][A-Za-z0-9+.-]*")
                || "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)
                || "javascript".equalsIgnoreCase(scheme) || "file".equalsIgnoreCase(scheme)
                || "data".equalsIgnoreCase(scheme) || "content".equalsIgnoreCase(scheme)) return null;
        String route = scheme + "://" + view;
        if (!"chat".equals(view)) return route;
        if (!uuid(notificationId)) return null;
        route += "?notificationId=" + notificationId;
        if (uuid(conversationId)) route += "&conversationId=" + conversationId;
        if (uuid(messageId)) route += "&messageId=" + messageId;
        return route;
    }
    private static boolean uuid(String value) {
        return value != null && value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }
}

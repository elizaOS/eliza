// spec/os/signIn/cloudRequests.md, "A mail or calendar route is sent only with the lease, never with the device key"
package ai.eliza.plugins.securestore.nativeonly;

import java.util.List;
import java.util.Map;

public final class MailReadRoutes {
 private static final String GOOGLE = "/api/v1/eliza/google/";
 private static final Map<String, List<String>> QUERIES = Map.of(
     GOOGLE + "status", List.of(),
     GOOGLE + "accounts", List.of("side"),
     GOOGLE + "gmail/triage", List.of("maxResults", "folder", "q", "counts", "pageToken", "grantId"),
     GOOGLE + "gmail/read", List.of("messageId", "grantId"),
     GOOGLE + "gmail/inbox-v1/history", List.of("grantId", "startHistoryId", "pageToken", "maxResults", "side"),
     GOOGLE + "calendar/feed", List.of("timeMin", "timeMax", "pageToken", "grantId"));

 private MailReadRoutes() {}

 public static List<String> queriesFor(String route) { return route == null ? null : QUERIES.get(route); }
}

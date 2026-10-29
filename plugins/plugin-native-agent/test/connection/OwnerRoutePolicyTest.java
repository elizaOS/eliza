package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.connection.OwnerRoutePolicy;
import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/** Host-JVM contract of the declarative owner-route interpreter. Not an Android or device test. */
public final class OwnerRoutePolicyTest {
  private static int assertions;

  private static void check(boolean value, String name) {
    assertions++;
    if (!value) throw new AssertionError(name);
  }

  static final String TABLE =
      "{\"unsafe\":\"[\\\\\\\\#\\\\t\\\\n\\\\u000B\\\\f\\\\r \\\\u00A0\\\\u2028\\\\u2029\\\\uFEFF]\","
          + "\"groups\":{"
          + "\"records\":{\"prefixes\":[\"/api/notes/state\",\"/api/lifeops/calendar\"],\"id\":\"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$\","
          + "\"routes\":[{\"methods\":[\"GET\"],\"paths\":[\"/api/notes/state\"]},"
          + "{\"methods\":[\"GET\"],\"paths\":[\"/api/lifeops/calendar/feed\"],\"query\":[\"timeMin\",\"timeMax\"]},"
          + "{\"methods\":[\"DELETE\"],\"paths\":[\"/api/lifeops/calendar/events/{id}\"],\"query\":[\"mode\"]}]},"
          + "\"automations\":{\"prefixes\":[\"/api/lifeops\",\"/api/triggers\"],\"id\":\"^(?!.*\\\\.\\\\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$\","
          + "\"routes\":[{\"methods\":[\"GET\"],\"paths\":[\"/api/lifeops/reminders\",\"/api/lifeops/scheduled-tasks?ownerVisibleOnly=1\",\"/api/triggers/{id}\"]},"
          + "{\"methods\":[\"POST\"],\"paths\":[\"/api/triggers/{id}/execute\"]},"
          + "{\"methods\":[\"PUT\",\"DELETE\"],\"paths\":[\"/api/triggers/{id}\"]}]},"
          + "\"approvals\":{\"prefixes\":[\"/api/approvals\"],\"routes\":[{\"methods\":[\"GET\"],\"paths\":[\"/api/approvals?state=all&limit=500\"]}]}"
          + "}}";

  public static void main(String[] args) throws Exception {
    OwnerRoutePolicy routes = new OwnerRoutePolicy(TABLE);

    // Longest claiming prefix wins; '/' and '?' boundaries only.
    check("records".equals(routes.group("/api/lifeops/calendar/feed")), "longest prefix claims calendar");
    check("automations".equals(routes.group("/api/lifeops/reminders")), "shorter prefix claims the rest");
    check("records".equals(routes.group("/api/notes/state?x=1")), "query boundary claims");
    check(routes.group("/api/lifeopsx") == null && routes.group("/api/notes/stateful") == null, "no partial-segment claim");
    check(routes.group("/api/conversations") == null && routes.group(null) == null, "unclaimed paths");
    check("automations".equals(routes.group("/api/lifeops/calendar/feed", "automations")), "group among named only");

    // Admitted routes.
    check(routes.allowed("records", "/api/notes/state", "GET"), "exact route");
    check(routes.allowed("records", "/api/lifeops/calendar/feed?timeMin=1&timeMax=2", "GET"), "declared query keys");
    check(routes.allowed("records", "/api/lifeops/calendar/feed", "GET"), "query route without query");
    check(routes.allowed("records", "/api/lifeops/calendar/events/evt%40host?mode=local", "DELETE"), "percent-decoded id");
    check(routes.allowed("automations", "/api/triggers/trigger-1", "GET"), "id route");
    check(routes.allowed("automations", "/api/triggers/trigger-1/execute", "POST"), "id route with tail");
    check(routes.allowed("automations", "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1", "GET"), "literal query route");
    check(routes.allowed("approvals", "/api/approvals?state=all&limit=500", "GET"), "literal approvals route");

    // Refused methods and routes.
    check(!routes.allowed("records", "/api/notes/state", "POST"), "method refused");
    check(!routes.allowed("records", "/api/notes/state/extra", "GET"), "claimed unmatched path refused");
    check(!routes.allowed("automations", "/api/lifeops/scheduled-tasks?ownerVisibleOnly=0", "GET"), "literal query must match");
    check(!routes.allowed("automations", "/api/lifeops/scheduled-tasks", "GET"), "literal query required");
    check(!routes.allowed("approvals", "/api/approvals?limit=500&state=all", "GET"), "literal query order");
    check(!routes.allowed("records", "/api/lifeops/calendar/feed?other=1", "GET"), "undeclared query key");
    check(!routes.allowed("records", "/api/lifeops/calendar/feed?timeMin=1&timeMin=2", "GET"), "repeated query key");
    check(!routes.allowed("records", "/api/lifeops/calendar/feed?time%4Din=1&timeMin=2", "GET"), "repeated decoded key");
    check(!routes.allowed("records", "/api/lifeops/calendar/feed?a=1?b=2", "GET"), "second query separator");

    // Normalisation bypasses.
    for (String path :
        new String[] {
          "//api/notes/state", "/api//notes/state", "/api/notes/state/", "/api/./notes/state", "/api/notes/../notes/state",
          "/api/notes/state/.", "/api/notes/state#x", "/api/notes/state\n", "/api/notes/state\t", "/api/notes/state ",
          "/api/notes/state ", "/api/notes/state ", "/api/notes/state﻿", "/api\\notes/state", "/api/notes/st%ate",
          "/api/notes/state%", "/api/notes/state%2", "api/notes/state", "", null
        })
      check(!routes.allowed("records", path, "GET"), "normalisation bypass refused: " + path);
    check(!routes.allowed("automations", "/api/triggers/a..b", "GET"), "id pattern refuses dot-dot");
    check(!routes.allowed("automations", "/api/triggers/a/b", "GET"), "id is one segment");
    check(!routes.allowed("automations", "/api/triggers/", "GET"), "empty id refused");
    check(!routes.allowed("automations", "/api/triggers/%2e%2e", "GET"), "literal-path id is not decoded into a match");
    check(!routes.allowed("records", "/api/lifeops/calendar/events/a%2Fb?mode=local", "DELETE"), "decoded slash refused by id pattern");
    check(!routes.allowed("records", "/api/lifeops/calendar/events/%ZZ?mode=local", "DELETE"), "malformed escape refused");
    check(routes.allowed("records", "/api/lifeops/calendar/events/a+b?mode=local", "DELETE"), "plus stays a literal plus");
    check(!routes.allowed("records", "/api/lifeops/calendar/events/a%20b?mode=local", "DELETE"), "decoded space fails the id pattern");

    // Oversized paths.
    StringBuilder longId = new StringBuilder("/api/triggers/");
    while (longId.length() <= OwnerRoutePolicy.PATH_LIMIT) longId.append('a');
    check(!routes.allowed("automations", longId.toString(), "GET"), "oversized path refused");

    // Unknown groups are caller errors.
    try {
      routes.allowed("missing", "/api/notes/state", "GET");
      check(false, "unknown group throws");
    } catch (IllegalArgumentException expected) {
      check(true, "unknown group throws");
    }

    // Invalid tables fail closed.
    for (String invalid :
        new String[] {
          "{}",
          "{\"unsafe\":\"[\",\"groups\":{}}",
          "{\"unsafe\":\"x\",\"groups\":{\"g\":{\"prefixes\":[\"/a\"],\"routes\":[{\"methods\":[\"GET\"],\"paths\":[\"/a/{id}\"]}]}}}",
          "not json"
        }) {
      try {
        new OwnerRoutePolicy(invalid);
        check(false, "invalid table refused: " + invalid);
      } catch (Exception expected) {
        check(true, "invalid table refused");
      }
    }

    // A shipped table loads once; a failure is not cached.
    AtomicInteger opens = new AtomicInteger();
    OwnerRoutePolicy.Shipped shipped = new OwnerRoutePolicy.Shipped("owner-routes.json");
    try {
      shipped.get(name -> {
        opens.incrementAndGet();
        throw new FileNotFoundException(name);
      });
      check(false, "missing asset refused");
    } catch (IllegalStateException expected) {
      check(true, "missing asset refused");
    }
    OwnerRoutePolicy.Assets assets =
        name -> {
          opens.incrementAndGet();
          check("owner-routes.json".equals(name), "asset name injected");
          return new ByteArrayInputStream(TABLE.getBytes(StandardCharsets.UTF_8));
        };
    OwnerRoutePolicy first = shipped.get(assets), second = shipped.get(assets);
    check(first == second && opens.get() == 2, "loaded once after a failed attempt");
    check(first.allowed("records", "/api/notes/state", "GET"), "shipped table admits");

    System.out.println("PASS owner route policy (" + assertions + " assertions)");
  }
}

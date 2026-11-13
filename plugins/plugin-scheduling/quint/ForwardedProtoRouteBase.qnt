// requestBaseUrl in plugins/plugin-scheduling/src/routes/plugin-routes.ts and
// plugins/plugin-calendar/src/routes/plugin-routes.ts builds the URL that a
// route parses from the Host and X-Forwarded-Proto headers. Proxies in front
// of the agent append a hop to X-Forwarded-Proto, and Node joins repeated
// header lines with ", ", so the route reads the first value, as the host
// route layer does. Whatever the proxies send, a request is served as the
// same request without the header is.
// route: 0 the scheduled-task list (GET /api/lifeops/scheduled-tasks),
// 1 a Google Calendar push notification
// (POST /api/lifeops/calendar/google/webhook).
// header: 0 no X-Forwarded-Proto, 1 one hop ("https"), 2 two hops on one
// line ("https, http"), 3 two header lines ("https" and "http"), 4 an empty
// value.
// status: 0 the request waits for the route, 1 served as a direct request,
// 2 failed with a server error.
// requests: how many requests reached the route; a run sends one or two.
module ForwardedProtoRouteBase {
  pure val Routes = 0.to(1)
  pure val Headers = 0.to(4)
  pure val MaxRequests = 2
  var route: int
  var header: int
  var status: int
  var requests: int

  // Every header shape is served; none fails.
  pure def respond(h: int): int = if (Headers.contains(h)) 1 else 2

  action init = {
    nondet r = Routes.oneOf()
    nondet h = Headers.oneOf()
    all { route' = r, header' = h, status' = 0, requests' = 1 }
  }
  action serve = all {
    status == 0,
    route' = route, header' = header, status' = respond(header),
    requests' = requests
  }
  // The next request to the same route, through the same or other proxies.
  action arrive = {
    nondet h = Headers.oneOf()
    all {
      status == 1, requests < MaxRequests,
      route' = route, header' = h, status' = 0, requests' = requests + 1
    }
  }
  // The route has not answered yet, or no further request arrives.
  action stutter = all {
    route' = route, header' = header, status' = status, requests' = requests
  }
  action step = any { serve, arrive, stutter }

  val ModelState = { route: route, header: header, status: status, requests: requests }
  temporal RequestServedWithoutFairness = (status == 0).leadsTo(status == 1)
  temporal RequestServed = serve.weakFair(ModelState)
    .implies(RequestServedWithoutFairness)

  val ProxiedRequestServed = status != 2
  val TypeOK =
    Routes.contains(route) and Headers.contains(header) and
    Set(0, 1, 2).contains(status) and 1 <= requests and requests <= MaxRequests
}

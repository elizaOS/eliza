import { SpeechRelayCoordinator } from "../../src/speech-relay-coordinator";

export class TestSpeechRelayCoordinator extends SpeechRelayCoordinator {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const stats = ((globalThis as any).__speechStats ??= {});
    if (path === "/test-lock-bootstrap") {
      stats.locked = true;
      return Response.json(stats);
    }
    if (path === "/test-allow-settlement") {
      stats.locked = false;
      return Response.json(stats);
    }
    if (path === "/test-decline") {
      stats.decline = true;
      return Response.json(stats);
    }
    if (path === "/test-stats") return Response.json(stats);
    return super.fetch(request);
  }
}
export default {
  fetch(request: Request, env: { SESSIONS: DurableObjectNamespace }) {
    const name = request.headers.get("x-test-session") ?? "test";
    return env.SESSIONS.get(env.SESSIONS.idFromName(name)).fetch(request);
  },
};

/** Real Maps controller and SQLite Durable Object storage; credential authority is an explicit fixture. */
import { MapsRequestAllowanceController } from "../../src/maps-request-allowance-controller";
export class MapsTestGate {
  private queue = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: Record<string, unknown>,
  ) {}
  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(async () => {
      const body = (await request.json()) as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      if (path === "/test/config") {
        this.env = { ...this.env, ...body };
        return Response.json({ configured: true });
      }
      if (path === "/test/seed") {
        await this.state.storage.put(body);
        return Response.json({ seeded: true });
      }
      if (path === "/test/read")
        return Response.json(
          (await this.state.storage.get(String(body.key))) ?? null,
        );
      if (path === "/credential/revoke") {
        await this.state.storage.put(`revoked:${body.credentialId}`, true);
        return Response.json({ committed: true });
      }
      return new MapsRequestAllowanceController(this.state.storage, this.env, {
        credential: async (value) =>
          value.kind === "api_key" &&
          (await this.state.storage.get(`revoked:${value.credentialId}`))
            ? new Response(null, { status: 403 })
            : null,
      }).handle(path, body);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
export default {
  fetch(request: Request, env: { GATES: DurableObjectNamespace }) {
    return env.GATES.getByName(request.headers.get("x-test-gate")!).fetch(
      request,
    );
  },
};

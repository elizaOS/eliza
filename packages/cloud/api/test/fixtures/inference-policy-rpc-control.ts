/** Test-only control worker; production's two Workers expose no public RPC route. */
export default {
  async fetch(
    request: Request,
    env: {
      PRIMARY: {
        configure(input: unknown): Promise<void>;
        stats(): Promise<{ policyReads: number; mutationReads: number }>;
      };
    },
  ) {
    if (new URL(request.url).pathname === "/configure") {
      await env.PRIMARY.configure(await request.json());
      return new Response(null, { status: 204 });
    }
    return Response.json(await env.PRIMARY.stats());
  },
};

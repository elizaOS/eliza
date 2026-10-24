import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import {
  consumeAppAuthCode,
  issueAppAuthCode,
} from "../../../shared/src/lib/services/app-auth-codes";

export { AuthenticationState } from "../../src/authentication-state";

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    const input = (await request.json()) as {
      operation: "issue" | "consume";
      code?: string;
    };
    const bindings = {
      ...env,
      CACHE_BACKEND: "auto",
      CLOUD_AUTH_STATE_BACKEND: "cloudflare",
    };
    return runWithCloudBindingsAsync(bindings, async () => {
      if (input.operation === "issue") {
        const issued = await issueAppAuthCode({
          appId: "app-a",
          userId: "user-a",
        });
        return Response.json(issued.code);
      }
      return Response.json(await consumeAppAuthCode(input.code ?? ""));
    });
  },
};

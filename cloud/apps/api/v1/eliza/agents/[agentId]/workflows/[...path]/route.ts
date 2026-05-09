import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleWorkflowProxyOptions, handleWorkflowProxyRequest } from "../_shared";

const app = new Hono<AppEnv>();

app.options("/*", () => handleWorkflowProxyOptions());

for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
  app.on(method, "/*", async (c) =>
    handleWorkflowProxyRequest(
      c.req.raw,
      c.req.param("agentId")!,
      c.req.param("*") ?? "",
      c,
    ),
  );
}

export default app;

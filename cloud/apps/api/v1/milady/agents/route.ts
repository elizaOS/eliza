import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import elizaAgentsApp from "../../eliza/agents/route";

const app = new Hono<AppEnv>();

app.route("/", elizaAgentsApp);

export default app;

import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import app from "../route";

export default app satisfies Hono<AppEnv>;

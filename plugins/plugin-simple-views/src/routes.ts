import type { Route } from "@elizaos/core";
import { interact } from "./simple-views.interact.js";
import { simpleViewsSnapshot } from "./storage.js";

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function stringBodyField(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function paramsBodyField(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = body.params;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const simpleViewsRoutes: Route[] = [
  {
    type: "GET",
    name: "simple-views-state",
    path: "/api/simple-views/state",
    public: true,
    rawPath: true,
    routeHandler: async () => ({
      status: 200,
      body: simpleViewsSnapshot(),
    }),
  },
  {
    type: "POST",
    name: "simple-views-interact",
    path: "/api/simple-views/interact",
    public: true,
    rawPath: true,
    routeHandler: async ({ body }) => {
      const record = requestBodyRecord(body);
      const capability = stringBodyField(record, "capability");
      if (!capability) {
        return {
          status: 400,
          body: { success: false, text: "Capability is required." },
        };
      }

      try {
        const interaction = await interact(capability, paramsBodyField(record));
        return {
          status: interaction.success ? 200 : 400,
          body: interaction,
        };
      } catch (error) {
        return {
          status: 400,
          body: {
            success: false,
            text: error instanceof Error ? error.message : String(error),
            state: simpleViewsSnapshot(),
          },
        };
      }
    },
  },
];

import { expect, test } from "bun:test";
import { app } from "./server";

test("OPTIONS requests return CORS headers", async () => {
  const response = await app.request("/chat", { method: "OPTIONS" });

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
});

test("POST /chat validates message body before runtime work", async () => {
  const response = await app.request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "" }),
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: "Message is required and must be a string",
  });
});

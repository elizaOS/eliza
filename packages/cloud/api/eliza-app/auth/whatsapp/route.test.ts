/**
 * A WhatsApp ID typed into a request is not proof of the WhatsApp account:
 * linking it routed that person's WhatsApp messages to the caller. The route is
 * retired in favour of the code flow (`identity-link/start`, platform whatsapp).
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { usersRepository } from "@elizaos/cloud-shared/db/repositories/users";
import { elizaAppSessionService } from "@elizaos/cloud-shared/lib/services/eliza-app";
import route from "./route";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("a signed-in caller cannot link a WhatsApp ID from the request body", async () => {
  spies.push(
    spyOn(elizaAppSessionService, "validateAuthHeader").mockResolvedValue({
      userId: "attacker-user",
      organizationId: "attacker-org",
    } as never),
    spyOn(
      usersRepository,
      "findByWhatsAppIdWithOrganization",
    ).mockResolvedValue(undefined as never),
  );
  const update = spyOn(usersRepository, "update").mockResolvedValue(
    undefined as never,
  );
  spies.push(update);

  const response = await route.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer attacker-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ whatsapp_id: "14155550123" }),
    },
    { RATE_LIMIT_DISABLED: "true", NODE_ENV: "test" },
  );

  expect(response.status).toBe(410);
  expect(update).not.toHaveBeenCalled();
});

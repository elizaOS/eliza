import { runWithTrajectoryContext, SecretSwapSession } from "@elizaos/core";
import { expect, test } from "vitest";
import { restorePiiInUserReplyText } from "./reply-policy";

test("user replies restore contact data in the owning turn while retaining credential redaction", async () => {
  const contact = "contact@example.invalid";
  const credential = "synthetic-private-value-123456789";
  const session = new SecretSwapSession({
    knownSecrets: { token: credential },
  });
  const wire = session.substituteText(
    `Contact ${contact}; token ${credential}`,
  );
  expect(wire).not.toContain(contact);
  expect(wire).not.toContain(credential);
  const restored = await runWithTrajectoryContext(
    { secretSwapSession: session },
    () => restorePiiInUserReplyText(wire),
  );
  expect(restored).toBe(`Contact ${contact}; token [redacted credential]`);
  expect(restorePiiInUserReplyText(wire)).toBe(wire);
  expect(session.restoreText(wire)).toBe(
    `Contact ${contact}; token ${credential}`,
  );
});

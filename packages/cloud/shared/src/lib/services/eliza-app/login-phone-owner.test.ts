/**
 * Telegram and Discord login take the phone number from the client; neither
 * provider proves it. A login must not attach itself to the account that
 * already owns that phone (an iMessage/SMS/voice-first account), or anyone who
 * knows a phone number signs in as its owner.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { usersRepository } from "../../../db/repositories/users";
import { elizaAppUserService } from "./user-service";

const PHONE = "+14155550123";
const victim = {
  id: "victim-user",
  phone_number: PHONE,
  phone_verified: true,
  telegram_id: null,
  discord_id: null,
  organization: { id: "victim-org", is_active: true },
};

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function stub<T extends object>(target: T, method: keyof T, value: unknown) {
  const spy = spyOn(target, method as never).mockResolvedValue(value as never);
  spies.push(spy);
  return spy;
}

test("Telegram login with someone else's phone number does not take over their account", async () => {
  stub(usersRepository, "findByTelegramIdWithOrganization", undefined);
  stub(usersRepository, "findByPhoneNumberWithOrganization", victim);
  const link = stub(usersRepository, "linkTelegramAndPhoneIdentity", { status: "linked" });

  await expect(
    elizaAppUserService.findOrCreateByTelegramWithPhone(
      { id: 777, first_name: "Attacker", auth_date: 1, hash: "signed" } as never,
      PHONE,
    ),
  ).rejects.toThrow("PHONE_ALREADY_LINKED");
  expect(link).not.toHaveBeenCalled();
});

test("Discord login with someone else's phone number does not take over their account", async () => {
  stub(usersRepository, "findByDiscordIdWithOrganization", undefined);
  stub(usersRepository, "findByCanonicalDiscordIdWithOrganization", undefined);
  stub(usersRepository, "findByPhoneNumberWithOrganization", victim);
  const update = stub(usersRepository, "update", victim);

  await expect(
    elizaAppUserService.findOrCreateByDiscordId(
      "discord-attacker",
      { username: "attacker" },
      PHONE,
    ),
  ).rejects.toThrow("PHONE_ALREADY_LINKED");
  expect(update).not.toHaveBeenCalled();
});

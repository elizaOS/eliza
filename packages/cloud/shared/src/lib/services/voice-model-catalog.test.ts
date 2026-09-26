import { expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { fingerprintPublicKey, signVoiceModelCatalog } from "./voice-model-catalog";

test("catalog signing accepts standard key encodings and rejects silently corrupted credentials", async () => {
  const seed = Buffer.alloc(32, 251);
  const encoded = seed.toString("base64");
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    type: "pkcs8",
    format: "der",
  });
  const bodyText = '{"catalog":"日本語"}';
  for (const secretKeyBase64 of [
    encoded,
    encoded.replace(/=+$/, ""),
    seed.toString("base64url"),
    ` \n${encoded}\n`,
  ]) {
    const signature = await signVoiceModelCatalog({ bodyText, secretKeyBase64 });
    expect(
      verify(
        null,
        Buffer.from(bodyText),
        createPublicKey(privateKey),
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
    expect(fingerprintPublicKey(secretKeyBase64)).toBe(encoded);
  }
  const slack = Buffer.alloc(32).toString("base64").slice(0, -2) + "B=";
  for (const secretKeyBase64 of [
    encoded + "!",
    encoded.slice(0, 8) + " " + encoded.slice(8),
    encoded.replace("+", "-"),
    slack,
  ]) {
    await expect(signVoiceModelCatalog({ bodyText, secretKeyBase64 })).rejects.toThrow();
    expect(() => fingerprintPublicKey(secretKeyBase64)).toThrow();
  }
});

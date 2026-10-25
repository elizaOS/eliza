/** Exercises the cloud APNs provider inside Workerd without external network access or credentials. */

import {
  CloudApnsProvider,
  ELIZA_IOS_BUNDLE_ID,
  resolveCloudApnsConfig,
} from "../../../shared/src/lib/mobile-push/apns-provider";

function base64urlBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function pem(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

export default {
  async fetch(): Promise<Response> {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const config = resolveCloudApnsConfig({
      ELIZA_APNS_KEY: pem(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey)),
      ),
      ELIZA_APNS_KEY_ID: "WORKERKEY",
      ELIZA_APNS_TEAM_ID: "WORKERTEAM",
      ELIZA_APNS_TOPIC: ELIZA_IOS_BUNDLE_ID,
      ELIZA_APNS_PRODUCTION: "0",
    });
    if (!config)
      throw new Error("Workerd APNs fixture configuration was absent");

    const requests: Array<{
      authorization: string;
      collapseId: string | null;
      url: string;
    }> = [];
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("authorization") ?? "",
        collapseId: headers.get("apns-collapse-id"),
        url: String(input),
      });
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "workerd-accepted" },
      });
    }) as unknown as typeof fetch;
    const provider = new CloudApnsProvider(config, request);
    const now = 1_800_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        provider.send(
          `device-${index}`,
          { title: "Ready", collapseKey: "reminder:occurrence-1" },
          now,
        ),
      ),
    );
    const jwt = requests[0]?.authorization.replace("bearer ", "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      arrayBuffer(base64urlBytes(signature ?? "")),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return Response.json({
      accepted: results.every(
        (result) =>
          result.outcome === "accepted" && result.apnsId === "workerd-accepted",
      ),
      collapseIds: [...new Set(requests.map((request) => request.collapseId))],
      jwtHeaders: [
        ...new Set(requests.map((request) => request.authorization)),
      ],
      sandbox: requests.every((request) =>
        request.url.startsWith("https://api.sandbox.push.apple.com/3/device/"),
      ),
      topic: config.topic,
      verified,
    });
  },
};

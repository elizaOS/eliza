/**
 * Exercises the packaged Android audit with the installed Coinbase analytics
 * payload and adversarial source changes; no wallet or script is executed.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findAndroidPlayTextAssetFindings } from "../mobile/android/cloud-policy.mjs";

const requireUi = createRequire(
  new URL("../../../ui/package.json", import.meta.url),
);
const wagmiEntry = requireUi.resolve("wagmi/connectors");
const connectorsEntry = createRequire(wagmiEntry).resolve("@wagmi/connectors");
const sdkEntry = createRequire(connectorsEntry).resolve("@coinbase/wallet-sdk");
const { TELEMETRY_SCRIPT_CONTENT: telemetry } = await import(
  pathToFileURL(
    path.join(path.dirname(sdkEntry), "core/telemetry/telemetry-content.js"),
  ).href
);

const asset = "base/assets/public/vendor-crypto.js";
const audit = (source) =>
  findAndroidPlayTextAssetFindings([asset], [Buffer.from(source)]);

describe("complete analytics literal admission at the packaged text boundary", () => {
  it("accepts the installed audited payload without changing its bytes", () => {
    const source = `const analytics = ${JSON.stringify(telemetry)};`;
    const bytes = Buffer.from(source);
    expect(findAndroidPlayTextAssetFindings([asset], [bytes])).toEqual([]);
    expect(bytes.toString("utf8")).toBe(source);
  });

  it.each([
    ["registration", 'navigator.serviceWorker.register("/sw.js");'],
    [
      "controller routing",
      'navigator.serviceWorker.controller.postMessage({route:"local"});',
    ],
    [
      "quoted routing",
      'const payload = "navigator.serviceWorker.register(\\"/sw.js\\")";',
    ],
  ])("rejects %s alongside the audited payload", (_label, extra) => {
    expect(
      audit(`const analytics = ${JSON.stringify(telemetry)};${extra}`),
    ).toContain(`${asset}: local routing marker navigator.serviceWorker`);
  });

  it("rejects a modified SDK script even when its worker references are unchanged", () => {
    expect(
      audit(`const analytics = ${JSON.stringify(`${telemetry}\nvoid 0;`)};`),
    ).toContain(`${asset}: local routing marker navigator.serviceWorker`);
  });

  it("does not shift executable routing into an admitted literal after Unicode text", () => {
    const source = `/* ${"İ".repeat(1000)} */\nnavigator.serviceWorker.controller.postMessage("route");\nconst analytics = ${JSON.stringify(telemetry)};`;
    expect(audit(source)).toContain(
      `${asset}: local routing marker navigator.serviceWorker`,
    );
  });

  it.each([
    ["executable source", telemetry],
    ["comment", `/* ${JSON.stringify(telemetry)} */`],
    ["malformed source", `const = ${JSON.stringify(telemetry)};`],
  ])("does not exempt %s containing the same payload", (_label, source) => {
    expect(audit(source)).toContain(
      `${asset}: local routing marker navigator.serviceWorker`,
    );
  });

  it("continues rejecting other routing markers in an admitted asset", () => {
    expect(
      audit(
        `const analytics = ${JSON.stringify(telemetry)}; const host = "10.0.2.2";`,
      ),
    ).toContain(`${asset}: local routing marker 10.0.2.2`);
  });
});

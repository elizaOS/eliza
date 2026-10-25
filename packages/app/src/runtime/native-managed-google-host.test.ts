import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  startNativeManagedGoogleHost,
  startNativeManagedGoogleHostForBoot,
} from "./native-managed-google-host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-google-admission-")),
  );
  roots.push(root);
  const entry = path.join(root, "google-host.mjs");
  const bytes =
    Buffer.from(`export async function startNativeGoogleAgentHost(options) {
    options.assertCurrent();
    return {port:47899,async close(){}};
  }`);
  fs.writeFileSync(entry, bytes);
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      files: {
        "google-host.mjs": createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ELIZA_PLATFORM: "android",
    ELIZA_SMTHRS_RUNTIME_DIR: root,
    ELIZA_NATIVE_GOOGLE_HOST_MODULE: entry,
    ELIZA_NATIVE_GOOGLE_BINDING_JSON: "{}",
    ELIZAOS_CLOUD_API_KEY: "synthetic-only",
    ELIZA_API_TOKEN: "Z_-q".repeat(16),
  };
  return { root, entry, env };
}
test("authenticated native resource loading publishes read ports, withholds Gmail send by default and retires them together", async () => {
  const f = fixture();
  const host = await startNativeManagedGoogleHost(f.env);
  expect(host).toBeDefined();
  for (const name of [
    "ELIZA_MANAGED_GMAIL_READ_BROKER",
    "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
    "ELIZA_MANAGED_CALENDAR_READ_BROKER",
  ])
    expect(f.env[name]).toBe("http://127.0.0.1:47899/__alpha-owner-gmail");
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBeUndefined();
  await host?.close();
  expect(f.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
  expect(f.env.ELIZA_MANAGED_GMAIL_OPERATION_BROKER).toBeUndefined();
  expect(f.env.ELIZA_MANAGED_CALENDAR_READ_BROKER).toBeUndefined();
});
test("Gmail send is published only when the host explicitly enables it", async () => {
  const f = fixture();
  f.env.ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED = "1";
  const host = await startNativeManagedGoogleHost(f.env);
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBe(
    "http://127.0.0.1:47899/__alpha-owner-gmail",
  );
  await host?.close();
  expect(f.env.ELIZA_MANAGED_GMAIL_SEND_BROKER).toBeUndefined();
});
test("native host refuses altered modules, foreign resource paths and desktop activation", async () => {
  const altered = fixture();
  fs.appendFileSync(altered.entry, "\nthrow Error('must not run');");
  await expect(startNativeManagedGoogleHost(altered.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
  const escaped = fixture();
  escaped.env.ELIZA_NATIVE_GOOGLE_HOST_MODULE = path.join(
    escaped.root,
    "..",
    "foreign.mjs",
  );
  await expect(startNativeManagedGoogleHost(escaped.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
  const desktop = fixture();
  desktop.env.ELIZA_PLATFORM = "darwin";
  await expect(startNativeManagedGoogleHost(desktop.env)).rejects.toMatchObject(
    { code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" },
  );
});
test("boot admission failures leave Google unavailable without stopping the agent or leaking the binding", async () => {
  const f = fixture();
  delete f.env.ELIZAOS_CLOUD_API_KEY;
  const warnings: string[] = [];
  await expect(
    startNativeManagedGoogleHostForBoot(f.env, (m) => warnings.push(m)),
  ).resolves.toBeUndefined();
  expect(warnings.join("\n")).toContain(
    "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE",
  );
  const malformed = fixture();
  malformed.env.ELIZA_NATIVE_GOOGLE_BINDING_JSON = '{"grant":"private-grant"';
  const error = await startNativeManagedGoogleHost(malformed.env).catch(
    (e: unknown) => e as Error,
  );
  expect(error).toMatchObject({
    code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE",
  });
  expect(String((error as Error).message)).not.toContain("private-grant");
  const badToken = fixture();
  badToken.env.ELIZA_API_TOKEN = "short";
  await expect(
    startNativeManagedGoogleHost(badToken.env),
  ).rejects.toMatchObject({ code: "NATIVE_MANAGED_GOOGLE_HOST_UNAVAILABLE" });
  expect(badToken.env.ELIZA_MANAGED_GMAIL_READ_BROKER).toBeUndefined();
});

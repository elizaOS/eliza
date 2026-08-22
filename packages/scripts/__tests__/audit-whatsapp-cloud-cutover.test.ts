/** Exercises the hosted WhatsApp deletion ratchet against the repository and a forbidden fixture. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditWhatsAppCloudCutover } from "../audit-whatsapp-cloud-cutover.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("hosted WhatsApp cutover audit", () => {
  test("accepts the checked-in hard cutover", async () => {
    await expect(auditWhatsAppCloudCutover()).resolves.toMatchObject({
      retiredPaths: 10,
    });
  });

  test("rejects a reintroduced Meta credential authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "whatsapp-cloud-cutover-"));
    temporaryRoots.push(root);
    const target = path.join(
      root,
      "packages/cloud/shared/src/lib/reintroduced.ts",
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      "export const credential = process.env.WHATSAPP_ACCESS_TOKEN;\n",
    );
    await expect(auditWhatsAppCloudCutover(root)).rejects.toThrow(
      "WHATSAPP_ACCESS_TOKEN",
    );
  });
});

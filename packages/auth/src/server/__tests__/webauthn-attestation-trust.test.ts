import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCertificatePath } from "@simplewebauthn/server/helpers";

test("rejects an untrusted attestation chain before requesting its revocation URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webauthn-trust-"));
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("Not a certificate revocation list", { status: 404 });
    },
  });
  try {
    for (const name of ["trusted", "untrusted"]) {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-keyout",
          join(directory, `${name}.key`),
          "-out",
          join(directory, `${name}.pem`),
          "-days",
          "2",
          "-subj",
          `/CN=${name}-test`,
          "-addext",
          `crlDistributionPoints=URI:http://127.0.0.1:${server.port}/${name}.crl`,
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
    }
    const trusted = await readFile(join(directory, "trusted.pem"), "utf8");
    const untrusted = await readFile(join(directory, "untrusted.pem"), "utf8");
    await expect(
      validateCertificatePath([untrusted], [trusted]),
    ).rejects.toMatchObject({
      code: "CERTIFICATE_PATH_VERIFICATION_FAILED",
    });
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

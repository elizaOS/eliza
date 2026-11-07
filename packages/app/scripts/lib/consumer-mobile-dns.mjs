import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConsumerSourceError,
  exportCommittedSources,
} from "./committed-source.mjs";

const baseSources = [
  "packages/agent/src/runtime/mobile-dns.ts",
  "packages/agent/src/runtime/mobile-dns-decode-budget.ts",
  "packages/host/src/runtime-env.ts",
  "packages/host/src/config/boot-config-store.ts",
  ...["errors.ts", "security/bind-host.ts"].map(
    (name) => `packages/core/src/${name}`,
  ),
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Bundle the reviewed mobile resolver without a workspace install or source rewriting. */
export function buildConsumerMobileDns(output, { sourceRoot, sourceCommit }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-mobile-dns-"));
  try {
    exportCommittedSources(sourceRoot, sourceCommit, temporary, [
      ...baseSources,
      "packages/core/src",
    ]);
    const envModule = ["utils/env-alias.ts", "utils/env.ts"].find((name) =>
      fs.existsSync(path.join(temporary, "packages/core/src", name)),
    );
    if (!envModule)
      throw new ConsumerSourceError(
        "Committed environment helpers are missing",
      );
    // Environment helpers moved into utils/env.ts; older reviewed commits retain
    // env-utils.ts. Both layouts must resolve from exported immutable bytes.
    const optionalCoreSources = ["env-utils.ts", "utils/errors.ts"].filter(
      (name) => fs.existsSync(path.join(temporary, "packages/core/src", name)),
    );
    const sources = [
      ...baseSources,
      ...[envModule, ...optionalCoreSources].map(
        (name) => `packages/core/src/${name}`,
      ),
    ];
    // Public imports resolve to these exact committed implementations. Keep this
    // entrypoint independent of unrelated exports in the full protocol barrels.
    fs.writeFileSync(
      path.join(temporary, "core.ts"),
      [
        "errors.ts",
        ...optionalCoreSources.filter((name) => name === "env-utils.ts"),
        envModule,
        "security/bind-host.ts",
      ]
        .map((name) => `export * from './packages/core/src/${name}';`)
        .join("\n"),
    );
    fs.writeFileSync(
      path.join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@elizaos/core/protocol": ["./core.ts"],
            "@elizaos/host/protocol": ["./packages/host/src/runtime-env.ts"],
          },
        },
      }),
    );
    const destination = path.resolve(output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    execFileSync(
      "bun",
      [
        "build",
        "packages/agent/src/runtime/mobile-dns.ts",
        "--target=bun",
        "--outfile",
        destination,
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    const provenance = {
      schemaVersion: 1,
      sourceCommit,
      bundleSha256: digest(fs.readFileSync(destination)),
      sourceHashes: Object.fromEntries(
        sources.map((name) => [
          name,
          digest(fs.readFileSync(path.join(temporary, name))),
        ]),
      ),
    };
    fs.writeFileSync(
      `${destination}.json`,
      JSON.stringify(provenance, null, 2) + "\n",
    );
    return provenance;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Admit the bundle and complete selected source closure against the host's pin. */
export function verifyConsumerMobileDns(file, { sourceRoot, sourceCommit }) {
  const spec = JSON.parse(fs.readFileSync(`${file}.json`));
  if (
    spec?.schemaVersion !== 1 ||
    spec.sourceCommit !== sourceCommit ||
    !spec.sourceHashes ||
    typeof spec.sourceHashes !== "object" ||
    Array.isArray(spec.sourceHashes) ||
    spec.bundleSha256 !== digest(fs.readFileSync(file))
  )
    throw new ConsumerSourceError("Mobile DNS bundle provenance mismatch");
  // The adjacent sidecar is not an authority. Rebuild from the reviewed commit
  // with the pinned host toolchain to bind executable bytes to source bytes.
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-mobile-dns-verify-"),
  );
  try {
    const expected = buildConsumerMobileDns(
      path.join(temporary, "resolver.mjs"),
      { sourceRoot, sourceCommit },
    );
    if (
      JSON.stringify(Object.keys(spec.sourceHashes).sort()) !==
      JSON.stringify(Object.keys(expected.sourceHashes).sort())
    )
      throw new ConsumerSourceError("Mobile DNS source inventory mismatch");
    for (const name of Object.keys(expected.sourceHashes))
      if (spec.sourceHashes[name] !== expected.sourceHashes[name])
        throw new ConsumerSourceError(`Mobile DNS source mismatch: ${name}`);
    if (spec.bundleSha256 !== expected.bundleSha256)
      throw new ConsumerSourceError(
        "Mobile DNS bundle differs from reviewed source build",
      );
    return spec;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

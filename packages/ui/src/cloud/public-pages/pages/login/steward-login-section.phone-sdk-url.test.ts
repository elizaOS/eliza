/** Qualifies the real source constructor slice against the current public SDK. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../../../../..");
const login = path.join(
  root,
  "packages/ui/src/cloud/public-pages/pages/login/steward-login-section.tsx",
);
const session = path.join(
  root,
  "packages/ui/src/cloud/public-pages/lib/steward-session.ts",
);
const urls = path.join(root, "packages/ui/src/cloud/shell/steward-url.ts");
const loginSource = ts.createSourceFile(
  login,
  readFileSync(login, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let constructors: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.name.elements
      .map((element) => element.name.getText(loginSource))
      .join(",") === "auth,phoneAuth"
  )
    constructors = node;
  ts.forEachChild(node, visit);
}
visit(loginSource);
if (!constructors)
  throw new Error("Actual auth/phoneAuth source constructor missing");
const sessionSource = ts.createSourceFile(
  session,
  readFileSync(session, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const endpoint = sessionSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "resolveStewardAuthEndpoint",
);
if (!endpoint) throw new Error("Actual endpoint resolver missing");
const urlSource = ts.createSourceFile(
  urls,
  readFileSync(urls, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
// Select exact pure declarations, not a second implementation of URL routing.
const mapping = urlSource.statements
  .filter((node) => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text === "hostname";
    return (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        ["production", "staging", "ELIZA_CLOUD_DIRECT_API_BY_HOST"].includes(
          declaration.name.getText(urlSource),
        ),
      )
    );
  })
  .map((node) => node.getText(urlSource).replace(/^export /, ""))
  .join("\n");
const program = `${mapping}\n${endpoint.getText(sessionSource).replace(/^export /, "")}\nconst ${constructors.getText(loginSource)};\nglobalThis.__result = {main: auth.getBaseUrl(), phone: phoneAuth.getBaseUrl(), mainTenant: auth.getTenantId(), phoneTenant: phoneAuth.getTenantId(), rawPhoneEndpoint: resolveStewardAuthEndpoint("/steward/cloud-owner-phone")};`;
// Bun executes the genuine current SDK, without Vite pre-resolving optional
// passkey imports. No Core substitute or copied SDK constructor is involved.
const probe = `
  import {LoginAuth} from ${JSON.stringify(path.join(root, "packages/auth/src/sdk/auth.ts"))};
  import {ELIZA_DOMAIN_CONTRACTS, LEGACY_ELIZA_DOMAIN_CONTRACTS} from ${JSON.stringify(path.join(root, "plugins/plugin-elizacloud/src/cloud-config/domain-contract.ts"))};
  import {runInNewContext} from "node:vm";
  const input = JSON.parse(process.argv.at(-1));
  let requests = 0;
  globalThis.fetch = () => {requests++; throw new Error("Constructor must not send requests");};
  if (input.directBaseUrl) {
    new LoginAuth({baseUrl: input.directBaseUrl});
  } else {
    const result = runInNewContext(new Bun.Transpiler({loader: "ts"}).transformSync(input.program), {
      LoginAuth, URL, ELIZA_DOMAIN_CONTRACTS, LEGACY_ELIZA_DOMAIN_CONTRACTS,
      window: {location: new URL(input.origin)}, useMemo: (factory) => factory(),
      stewardApiUrl: input.override, STEWARD_TENANT_ID: "fixture-main-tenant"
    });
    console.log(JSON.stringify({...result, requests, bunVersion: Bun.version}));
  }
`;
const bun = process.env.BUN_EXECUTABLE ?? "bun";
const override = "https://external-steward.example/steward";

describe("phone SDK browser-origin construction", () => {
  it.each([
    [
      "https://preview.eliza.pages.dev",
      "https://preview.eliza.pages.dev",
      "/steward/cloud-owner-phone",
    ],
    [
      "http://127.0.0.1:55132",
      "http://127.0.0.1:55132",
      "/steward/cloud-owner-phone",
    ],
    [
      "http://localhost:55131",
      "http://localhost:55131",
      "/steward/cloud-owner-phone",
    ],
    [
      "https://cloud.eliza.app",
      "https://cloud.eliza.app",
      "https://cloud.eliza.app/steward/cloud-owner-phone",
    ],
    [
      "https://cloud-staging.eliza.app",
      "https://cloud-staging.eliza.app",
      "https://cloud-staging.eliza.app/steward/cloud-owner-phone",
    ],
    [
      "https://www.eliza.app",
      "https://eliza.app",
      "https://eliza.app/steward/cloud-owner-phone",
    ],
  ])(
    "constructs genuine SDKs on %s without changing phone authority",
    (origin, phoneOrigin, rawPhoneEndpoint) => {
      const result = JSON.parse(
        execFileSync(
          bun,
          ["--eval", probe, JSON.stringify({ program, origin, override })],
          { encoding: "utf8", stdio: "pipe" },
        ),
      );
      expect(result.main).toBe(override);
      expect(result.phone).toBe(`${phoneOrigin}/steward/cloud-owner-phone`);
      expect(result.mainTenant).toBe("fixture-main-tenant");
      expect(result.phoneTenant).toBeUndefined();
      expect(result.rawPhoneEndpoint).toBe(rawPhoneEndpoint);
      expect(result.requests).toBe(0);
    },
  );

  it.each([
    ["/steward/cloud-owner-phone", "absolute URL"],
    ["http://foreign.example/steward/cloud-owner-phone", "HTTPS"],
  ])(
    "retains genuine SDK transport rejection for %s",
    (directBaseUrl, message) => {
      expect(() =>
        execFileSync(
          bun,
          ["--eval", probe, JSON.stringify({ directBaseUrl })],
          {
            encoding: "utf8",
            stdio: "pipe",
          },
        ),
      ).toThrow(message);
    },
  );
});

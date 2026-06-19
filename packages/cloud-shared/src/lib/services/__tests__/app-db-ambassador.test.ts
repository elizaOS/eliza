import { describe, expect, test } from "bun:test";
import {
  ambassadorName,
  ambassadorNameForContainer,
  buildEnsureAmbassadorCmds,
  buildRemoveAmbassadorCmdForContainer,
  parseDsnEndpoint,
  rewriteDsnToAmbassador,
} from "../app-db-ambassador";

const APP_ID = "11111111-2222-3333-4444-555555555555";

describe("ambassador naming", () => {
  test("ambassadorName uses the same 12-char slug as the app container", () => {
    expect(ambassadorName(APP_ID)).toBe("app-db-111111112222");
  });

  test("ambassadorNameForContainer derives from the app container name", () => {
    expect(ambassadorNameForContainer("app-111111112222")).toBe("app-db-111111112222");
    // round-trips with ambassadorName for the same app
    expect(ambassadorNameForContainer("app-111111112222")).toBe(ambassadorName(APP_ID));
  });
});

describe("parseDsnEndpoint", () => {
  test("extracts host + port from a full DSN", () => {
    expect(parseDsnEndpoint("postgresql://u:p@10.43.0.10:5432/db?sslmode=require")).toEqual({
      host: "10.43.0.10",
      port: 5432,
    });
  });

  test("defaults the port to 5432 when absent", () => {
    expect(parseDsnEndpoint("postgresql://u:p@db.internal/appdb")).toEqual({
      host: "db.internal",
      port: 5432,
    });
  });

  test("is not fooled by an @ that isn't present (returns null)", () => {
    expect(parseDsnEndpoint("postgresql://localhost:5432/db")).toBeNull();
  });
});

describe("rewriteDsnToAmbassador", () => {
  test("replaces only host:port, preserving user/pass/db/params", () => {
    expect(
      rewriteDsnToAmbassador(
        "postgresql://app_x:p%40ss@10.43.0.10:5432/db_app_x?sslmode=require",
        "app-db-111111112222",
      ),
    ).toBe("postgresql://app_x:p%40ss@app-db-111111112222:5432/db_app_x?sslmode=require");
  });

  test("works when the original DSN omits the port", () => {
    expect(rewriteDsnToAmbassador("postgresql://u:p@host/db", "amb")).toBe(
      "postgresql://u:p@amb:5432/db",
    );
  });
});

describe("buildEnsureAmbassadorCmds", () => {
  test("rm stale -> run socat to the tenant DB -> attach to the app net", () => {
    const cmds = buildEnsureAmbassadorCmds({
      appId: APP_ID,
      network: "app-net-111111112222333344445555",
      db: { host: "10.43.0.10", port: 5432 },
    });
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toBe("docker rm -f 'app-db-111111112222' >/dev/null 2>&1 || true");
    // forwarder: dropped caps, started on the egress net (default bridge), socat target = the DB
    expect(cmds[1]).toContain("docker run -d --name 'app-db-111111112222'");
    expect(cmds[1]).toContain("--network 'bridge'");
    expect(cmds[1]).toContain("--cap-drop=ALL");
    expect(cmds[1]).toContain("'TCP-LISTEN:5432,fork,reuseaddr'");
    expect(cmds[1]).toContain("'TCP:10.43.0.10:5432'");
    expect(cmds[2]).toBe(
      "docker network connect 'app-net-111111112222333344445555' 'app-db-111111112222'",
    );
  });

  test("honors a custom egress network + image", () => {
    const cmds = buildEnsureAmbassadorCmds({
      appId: APP_ID,
      network: "app-net-x",
      db: { host: "db-node", port: 6543 },
      egressNetwork: "apps-db-egress",
      image: "alpine/socat:1.8.0.1",
    });
    expect(cmds[1]).toContain("--network 'apps-db-egress'");
    expect(cmds[1]).toContain("'alpine/socat:1.8.0.1'");
    expect(cmds[1]).toContain("'TCP:db-node:6543'");
  });
});

describe("buildRemoveAmbassadorCmdForContainer", () => {
  test("removes the ambassador derived from the container name (best-effort)", () => {
    expect(buildRemoveAmbassadorCmdForContainer("app-111111112222")).toBe(
      "docker rm -f 'app-db-111111112222' >/dev/null 2>&1 || true",
    );
  });
});

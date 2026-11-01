import { describe, expect, it } from "vitest";
import { requiresDockerHostGateway } from "./docker-sandbox-utils";

describe("requiresDockerHostGateway", () => {
  it("asks for a host-gateway alias when the container target is host.docker.internal", () => {
    expect(requiresDockerHostGateway("http://host.docker.internal:8787/steward")).toBe(true);
  });

  it("does not ask for a host-gateway alias for a routable remote target", () => {
    expect(requiresDockerHostGateway("http://10.4.2.9:8787/steward")).toBe(false);
  });

  it("does not ask for a host-gateway alias for a loopback target", () => {
    expect(requiresDockerHostGateway("http://127.0.0.1:8787/steward")).toBe(false);
  });

  it("reports a scheme-less STEWARD_CONTAINER_URL instead of silently skipping the alias", () => {
    // A missing scheme parses as protocol "host.docker.internal:" with an empty
    // hostname, so the old catch-less return answered "no alias needed" and the
    // container was created with a STEWARD_API_URL it can never dial.
    expect(() => requiresDockerHostGateway("host.docker.internal:8787")).toThrow(
      /Invalid steward container URL/,
    );
  });

  it("reports an unparseable STEWARD_CONTAINER_URL instead of silently skipping the alias", () => {
    expect(() => requiresDockerHostGateway("/steward")).toThrow(/Invalid steward container URL/);
  });
});

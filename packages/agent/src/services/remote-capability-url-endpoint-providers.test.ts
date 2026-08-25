/**
 * Unit coverage for URL-backed remote capability endpoint providers. Drives the
 * real `urlRemoteCapabilityEndpointProvider` factory and the home-machine,
 * mobile-companion, and desktop-companion singletons: endpoint-id fallback
 * order, http(s) baseUrl normalisation, token/module/metadata omission, and
 * the validation rejects (empty id, path/query separators, credentials,
 * non-http schemes). Deterministic — no network, no mocks of the module.
 */
import { describe, expect, it } from "vitest";
import {
  desktopCompanionCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  urlRemoteCapabilityEndpointProvider,
} from "./remote-capability-url-endpoint-providers.ts";

const HTTPS = "https://capability.example.test";

describe("urlRemoteCapabilityEndpointProvider", () => {
  it("returns a provider whose id is the given provider id", () => {
    const provider = urlRemoteCapabilityEndpointProvider("lab-host");
    expect(provider.id).toBe("lab-host");
  });

  it("uses the provider id as the endpoint id when neither options nor defaults supply one", async () => {
    const provider = urlRemoteCapabilityEndpointProvider("lab-host");
    await expect(provider.provision({ baseUrl: HTTPS })).resolves.toEqual({
      providerId: "lab-host",
      endpoint: { id: "lab-host", baseUrl: HTTPS },
    });
  });

  it("uses defaults.endpointId when options.endpointId is omitted", async () => {
    const provider = urlRemoteCapabilityEndpointProvider("lab-host", {
      endpointId: "lab-1",
    });
    const result = await provider.provision({ baseUrl: HTTPS });
    expect(result.endpoint.id).toBe("lab-1");
    expect(result.providerId).toBe("lab-host");
  });

  it("lets options.endpointId win over defaults.endpointId", async () => {
    const provider = urlRemoteCapabilityEndpointProvider("lab-host", {
      endpointId: "lab-1",
    });
    const result = await provider.provision({
      baseUrl: HTTPS,
      endpointId: "lab-override",
    });
    expect(result.endpoint.id).toBe("lab-override");
  });

  it("treats an empty options.endpointId as present and rejects it instead of falling back", async () => {
    const provider = urlRemoteCapabilityEndpointProvider("lab-host", {
      endpointId: "lab-1",
    });
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: "" }),
    ).rejects.toThrow(
      "Remote capability endpoint id must be a non-empty string.",
    );
  });
});

describe("ready-made URL endpoint providers", () => {
  it("exposes home-machine, mobile-companion, and desktop-companion ids", () => {
    expect(homeMachineCapabilityEndpointProvider.id).toBe("home-machine");
    expect(mobileCompanionCapabilityEndpointProvider.id).toBe(
      "mobile-companion",
    );
    expect(desktopCompanionCapabilityEndpointProvider.id).toBe(
      "desktop-companion",
    );
  });

  it("provisions each singleton with the provider id as the default endpoint id", async () => {
    await expect(
      homeMachineCapabilityEndpointProvider.provision({ baseUrl: HTTPS }),
    ).resolves.toMatchObject({
      providerId: "home-machine",
      endpoint: { id: "home-machine", baseUrl: HTTPS },
    });
    await expect(
      mobileCompanionCapabilityEndpointProvider.provision({ baseUrl: HTTPS }),
    ).resolves.toMatchObject({
      providerId: "mobile-companion",
      endpoint: { id: "mobile-companion", baseUrl: HTTPS },
    });
    await expect(
      desktopCompanionCapabilityEndpointProvider.provision({ baseUrl: HTTPS }),
    ).resolves.toMatchObject({
      providerId: "desktop-companion",
      endpoint: { id: "desktop-companion", baseUrl: HTTPS },
    });
  });
});

describe("endpoint id normalisation", () => {
  const provider = urlRemoteCapabilityEndpointProvider("lab-host");

  it("trims surrounding whitespace on a valid id", async () => {
    const result = await provider.provision({
      baseUrl: HTTPS,
      endpointId: "  lab-1  ",
    });
    expect(result.endpoint.id).toBe("lab-1");
  });

  it("rejects a whitespace-only id", async () => {
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: "   " }),
    ).rejects.toThrow(
      "Remote capability endpoint id must be a non-empty string.",
    );
  });

  it("rejects a slash, backslash, or query separator and quotes the original value", async () => {
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: "../mobile" }),
    ).rejects.toThrow(
      'Remote capability endpoint id "../mobile" must not contain path or query separators.',
    );
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: "lab\\host" }),
    ).rejects.toThrow(
      'Remote capability endpoint id "lab\\host" must not contain path or query separators.',
    );
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: "lab?x=1" }),
    ).rejects.toThrow(
      'Remote capability endpoint id "lab?x=1" must not contain path or query separators.',
    );
    await expect(
      provider.provision({ baseUrl: HTTPS, endpointId: " /padded " }),
    ).rejects.toThrow(
      'Remote capability endpoint id " /padded " must not contain path or query separators.',
    );
  });
});

describe("baseUrl normalisation", () => {
  const provider = urlRemoteCapabilityEndpointProvider("lab-host");

  it("accepts http and https and strips trailing slashes, query, and hash", async () => {
    await expect(
      provider.provision({ baseUrl: "http://capability.example.test/" }),
    ).resolves.toMatchObject({
      endpoint: { baseUrl: "http://capability.example.test" },
    });
    await expect(
      provider.provision({
        baseUrl: "https://capability.example.test/path/?q=1#frag",
      }),
    ).resolves.toMatchObject({
      endpoint: { baseUrl: "https://capability.example.test/path" },
    });
    await expect(
      provider.provision({ baseUrl: "https://capability.example.test///" }),
    ).resolves.toMatchObject({
      endpoint: { baseUrl: "https://capability.example.test" },
    });
  });

  it("trims surrounding whitespace and omits default http(s) ports", async () => {
    const trimmed = await provider.provision({
      baseUrl: "  https://capability.example.test/foo  ",
    });
    expect(trimmed.endpoint.baseUrl).toBe(
      "https://capability.example.test/foo",
    );

    const httpsDefault = await provider.provision({
      baseUrl: "https://capability.example.test:443",
    });
    expect(httpsDefault.endpoint.baseUrl).toBe(
      "https://capability.example.test",
    );

    const httpDefault = await provider.provision({
      baseUrl: "http://capability.example.test:80",
    });
    expect(httpDefault.endpoint.baseUrl).toBe("http://capability.example.test");

    const customPort = await provider.provision({
      baseUrl: "https://capability.example.test:8443/",
    });
    expect(customPort.endpoint.baseUrl).toBe(
      "https://capability.example.test:8443",
    );
  });

  it("preserves a non-root path and IPv6 host", async () => {
    const ipv6 = await provider.provision({
      baseUrl: "https://[::1]/x/",
    });
    expect(ipv6.endpoint.baseUrl).toBe("https://[::1]/x");
  });

  it("rejects a missing or whitespace-only baseUrl", async () => {
    await expect(provider.provision({ baseUrl: "" })).rejects.toThrow(
      "Remote capability endpoint baseUrl is required.",
    );
    await expect(provider.provision({ baseUrl: "   " })).rejects.toThrow(
      "Remote capability endpoint baseUrl is required.",
    );
  });

  it("rejects an unparseable baseUrl and quotes the original value", async () => {
    await expect(provider.provision({ baseUrl: "::::" })).rejects.toThrow(
      "Invalid remote capability endpoint baseUrl: ::::",
    );
    await expect(
      provider.provision({ baseUrl: "example.com" }),
    ).rejects.toThrow(
      "Invalid remote capability endpoint baseUrl: example.com",
    );
  });

  it("rejects non-http(s) schemes and quotes the original value", async () => {
    await expect(
      provider.provision({ baseUrl: "file:///tmp/capability" }),
    ).rejects.toThrow(
      'Remote capability endpoint baseUrl "file:///tmp/capability" must use http or https.',
    );
    await expect(
      provider.provision({ baseUrl: "ftp://files.example.test/x" }),
    ).rejects.toThrow(
      'Remote capability endpoint baseUrl "ftp://files.example.test/x" must use http or https.',
    );
    await expect(
      provider.provision({ baseUrl: "ws://capability.example.test" }),
    ).rejects.toThrow(
      'Remote capability endpoint baseUrl "ws://capability.example.test" must use http or https.',
    );
  });

  it("rejects embedded username or password credentials", async () => {
    await expect(
      provider.provision({
        baseUrl: "https://user:pass@capability.example.test",
      }),
    ).rejects.toThrow(
      'Remote capability endpoint baseUrl "https://user:pass@capability.example.test" must not include embedded credentials.',
    );
    await expect(
      provider.provision({
        baseUrl: "https://user@capability.example.test",
      }),
    ).rejects.toThrow("must not include embedded credentials");
    await expect(
      provider.provision({
        baseUrl: "https://:pass@capability.example.test",
      }),
    ).rejects.toThrow("must not include embedded credentials");
  });
});

describe("optional token, allowed modules, and metadata", () => {
  const provider = urlRemoteCapabilityEndpointProvider("lab-host");

  it("omits token when it is missing, empty, or whitespace", async () => {
    const missing = await provider.provision({ baseUrl: HTTPS });
    expect(missing.endpoint).not.toHaveProperty("token");

    const empty = await provider.provision({ baseUrl: HTTPS, token: "" });
    expect(empty.endpoint).not.toHaveProperty("token");

    const blank = await provider.provision({ baseUrl: HTTPS, token: "   " });
    expect(blank.endpoint).not.toHaveProperty("token");
  });

  it("trims a non-empty token onto the endpoint", async () => {
    const result = await provider.provision({
      baseUrl: HTTPS,
      token: "  secret-token  ",
    });
    expect(result.endpoint.token).toBe("secret-token");
  });

  it("omits allowedModuleIds when the list is missing, empty, or only blank entries", async () => {
    const missing = await provider.provision({ baseUrl: HTTPS });
    expect(missing).not.toHaveProperty("allowedModuleIds");

    const empty = await provider.provision({
      baseUrl: HTTPS,
      allowedModuleIds: [],
    });
    expect(empty).not.toHaveProperty("allowedModuleIds");

    const blanks = await provider.provision({
      baseUrl: HTTPS,
      allowedModuleIds: ["", "  ", "\t"],
    });
    expect(blanks).not.toHaveProperty("allowedModuleIds");
  });

  it("keeps a single module, trims entries, and dedupes while preserving first-seen order", async () => {
    const single = await provider.provision({
      baseUrl: HTTPS,
      allowedModuleIds: ["  one  "],
    });
    expect(single.allowedModuleIds).toEqual(["one"]);

    const mixed = await provider.provision({
      baseUrl: HTTPS,
      allowedModuleIds: [" beta ", "alpha", "beta", "", "alpha"],
    });
    expect(mixed.allowedModuleIds).toEqual(["beta", "alpha"]);
  });

  it("omits metadata when undefined and includes an explicit metadata object", async () => {
    const missing = await provider.provision({ baseUrl: HTTPS });
    expect(missing).not.toHaveProperty("metadata");

    const empty = await provider.provision({
      baseUrl: HTTPS,
      metadata: {},
    });
    expect(empty.metadata).toEqual({});

    const tagged = await provider.provision({
      baseUrl: HTTPS,
      metadata: { runtime: "lab", nested: { n: 1 } },
    });
    expect(tagged.metadata).toEqual({ runtime: "lab", nested: { n: 1 } });
  });
});

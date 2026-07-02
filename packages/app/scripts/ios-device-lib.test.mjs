/**
 * Unit tests for the pure decision logic behind the one-command iOS device
 * automation scripts (ios-device-deploy / ios-device-logs /
 * ios-device-capture). Runs in the packages/app vitest suite
 * (`bun run --cwd packages/app test`), i.e. the root test:client lane.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCodesignPlan,
  buildPlistXml,
  classifyConsoleExit,
  CONSOLE_SIGTRAP_SIGNATURE,
  deriveSigningEntitlements,
  extractXctestrunAppPaths,
  findDeviceRecord,
  normalizeProvisioningProfile,
  PlistData,
  parseCliArgs,
  parseCodesigningIdentities,
  parsePlist,
  profileMatchesTarget,
  resolveDeviceId,
  resolveXctestrunTestRoot,
  rewriteXctestrunUITargetApp,
  selectProvisioningProfile,
  selectSigningIdentity,
} from "./ios-device-lib.mjs";

const TEAM = "25877RY2EH";
const DEVICE_UDID = "00008140-0006491E2E90801C";
const CERT_DER = Buffer.from("fake-der-certificate-bytes");
const CERT_SHA1 = crypto
  .createHash("sha1")
  .update(CERT_DER)
  .digest("hex")
  .toUpperCase();

function profilePlist({
  name = "iOS Team Provisioning Profile: ai.elizaos.app",
  appIdentifier = `${TEAM}.ai.elizaos.app`,
  expiration = new Date("2027-06-22T00:00:00Z"),
  devices = [DEVICE_UDID],
  getTaskAllow = true,
} = {}) {
  return {
    Name: name,
    UUID: "11111111-2222-3333-4444-555555555555",
    TeamIdentifier: [TEAM],
    ApplicationIdentifierPrefix: [TEAM],
    ExpirationDate: expiration,
    ProvisionedDevices: devices,
    DeveloperCertificates: [new PlistData(CERT_DER.toString("base64"))],
    Entitlements: {
      "application-identifier": appIdentifier,
      "com.apple.developer.team-identifier": TEAM,
      "get-task-allow": getTaskAllow,
      "keychain-access-groups": [`${TEAM}.*`],
    },
  };
}

function normalized(
  overrides = {},
  sourcePath = "/profiles/a.mobileprovision",
) {
  return normalizeProvisioningProfile(profilePlist(overrides), sourcePath);
}

describe("parsePlist / buildPlistXml", () => {
  it("parses the value types Apple emits in provisioning profiles", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Name</key><string>iOS Team Provisioning Profile: ai.elizaos.app</string>
  <key>ExpirationDate</key><date>2027-06-22T12:34:56Z</date>
  <key>TTL</key><integer>365</integer>
  <key>Version</key><real>1.5</real>
  <key>IsXcodeManaged</key><true/>
  <key>Empty</key><dict/>
  <key>ProvisionedDevices</key>
  <array>
    <string>${DEVICE_UDID}</string>
  </array>
  <key>DeveloperCertificates</key>
  <array>
    <data>${CERT_DER.toString("base64")}</data>
  </array>
  <key>Escaped</key><string>a &lt;b&gt; &amp;c &#x41;</string>
</dict>
</plist>`;
    const parsed = parsePlist(xml);
    expect(parsed.Name).toBe("iOS Team Provisioning Profile: ai.elizaos.app");
    expect(parsed.ExpirationDate).toBeInstanceOf(Date);
    expect(parsed.ExpirationDate.toISOString()).toBe(
      "2027-06-22T12:34:56.000Z",
    );
    expect(parsed.TTL).toBe(365);
    expect(parsed.Version).toBe(1.5);
    expect(parsed.IsXcodeManaged).toBe(true);
    expect(parsed.Empty).toEqual({});
    expect(parsed.ProvisionedDevices).toEqual([DEVICE_UDID]);
    expect(parsed.DeveloperCertificates[0]).toBeInstanceOf(PlistData);
    expect(parsed.DeveloperCertificates[0].toBuffer().equals(CERT_DER)).toBe(
      true,
    );
    expect(parsed.Escaped).toBe("a <b> &c A");
  });

  it("round-trips a plist through serialize → parse", () => {
    const original = {
      Str: "hello & <world>",
      Int: 42,
      Real: 3.25,
      Yes: true,
      No: false,
      When: new Date("2026-07-01T00:00:00Z"),
      Blob: new PlistData(Buffer.from("bytes").toString("base64")),
      List: ["a", 1, false],
      Nested: { inner: "value" },
      EmptyList: [],
      EmptyDict: {},
    };
    const reparsed = parsePlist(buildPlistXml(original));
    expect(reparsed.Str).toBe(original.Str);
    expect(reparsed.Int).toBe(42);
    expect(reparsed.Real).toBe(3.25);
    expect(reparsed.Yes).toBe(true);
    expect(reparsed.No).toBe(false);
    expect(reparsed.When.getTime()).toBe(original.When.getTime());
    expect(reparsed.Blob.base64).toBe(original.Blob.base64);
    expect(reparsed.List).toEqual(["a", 1, false]);
    expect(reparsed.Nested).toEqual({ inner: "value" });
    expect(reparsed.EmptyList).toEqual([]);
    expect(reparsed.EmptyDict).toEqual({});
  });

  it("rejects malformed documents instead of guessing", () => {
    expect(() =>
      parsePlist(
        '<plist version="1.0"><dict><string>no key</string></dict></plist>',
      ),
    ).toThrow(/expected <key>/);
    expect(() => parsePlist('<plist version="1.0"><bogus/></plist>')).toThrow(
      /unsupported/,
    );
  });
});

describe("normalizeProvisioningProfile", () => {
  it("extracts identity, devices, expiry, and cert SHA-1s", () => {
    const profile = normalized();
    expect(profile.applicationIdentifier).toBe(`${TEAM}.ai.elizaos.app`);
    expect(profile.teamId).toBe(TEAM);
    expect(profile.appIdPrefix).toBe(TEAM);
    expect(profile.provisionedDevices).toEqual([DEVICE_UDID]);
    expect(profile.developerCertificateSha1s).toEqual([CERT_SHA1]);
    expect(profile.getTaskAllow).toBe(true);
    expect(profile.sourcePath).toBe("/profiles/a.mobileprovision");
  });

  it("tolerates minimal/malformed plists without throwing", () => {
    const profile = normalizeProvisioningProfile({}, "/dev/null");
    expect(profile.applicationIdentifier).toBeNull();
    expect(profile.provisionedDevices).toEqual([]);
    expect(profile.developerCertificateSha1s).toEqual([]);
    expect(profile.expirationDate).toBeNull();
  });
});

describe("profileMatchesTarget", () => {
  const target = { bundleId: "ai.elizaos.app", deviceUdid: DEVICE_UDID };

  it("accepts an exact-app-id, device-provisioned, unexpired profile", () => {
    expect(profileMatchesTarget(normalized(), target)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("accepts a team wildcard profile", () => {
    const profile = normalized({ appIdentifier: `${TEAM}.*` });
    expect(profileMatchesTarget(profile, target).ok).toBe(true);
  });

  it("accepts a prefix wildcard covering the appex bundle ids", () => {
    const profile = normalized({ appIdentifier: `${TEAM}.ai.elizaos.app.*` });
    const verdict = profileMatchesTarget(profile, {
      bundleId: "ai.elizaos.app.WebsiteBlockerContentExtension",
      deviceUdid: DEVICE_UDID,
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects an expired profile with the reason", () => {
    const profile = normalized({
      expiration: new Date("2020-01-01T00:00:00Z"),
    });
    const verdict = profileMatchesTarget(profile, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/expired 2020-01-01/);
  });

  it("rejects when the device is not provisioned", () => {
    const profile = normalized({ devices: ["00008140-DIFFERENTDEVICE"] });
    const verdict = profileMatchesTarget(profile, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/not in ProvisionedDevices/);
  });

  it("rejects a wrong-app profile", () => {
    const profile = normalized({ appIdentifier: `${TEAM}.com.other.app` });
    const verdict = profileMatchesTarget(profile, target);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/does not cover bundle id/);
  });

  it("skips the device check when no UDID is given (simulator lane)", () => {
    const profile = normalized({ devices: [] });
    expect(
      profileMatchesTarget(profile, {
        bundleId: "ai.elizaos.app",
        deviceUdid: null,
      }).ok,
    ).toBe(true);
  });
});

describe("selectProvisioningProfile", () => {
  const target = { bundleId: "ai.elizaos.app", deviceUdid: DEVICE_UDID };

  it("prefers an exact app-id profile over a wildcard", () => {
    const wildcard = normalized(
      { appIdentifier: `${TEAM}.*` },
      "/p/wild.mobileprovision",
    );
    const exact = normalized({}, "/p/exact.mobileprovision");
    const { selected } = selectProvisioningProfile([wildcard, exact], target);
    expect(selected.sourcePath).toBe("/p/exact.mobileprovision");
  });

  it("prefers the later expiration among equal specificity", () => {
    const older = normalized(
      { expiration: new Date("2026-08-01T00:00:00Z") },
      "/p/older.mobileprovision",
    );
    const newer = normalized(
      { expiration: new Date("2027-06-22T00:00:00Z") },
      "/p/newer.mobileprovision",
    );
    const { selected } = selectProvisioningProfile([older, newer], target);
    expect(selected.sourcePath).toBe("/p/newer.mobileprovision");
  });

  it("returns null + per-profile reasons when nothing matches", () => {
    const expired = normalized(
      { expiration: new Date("2020-01-01T00:00:00Z") },
      "/p/expired.mobileprovision",
    );
    const wrongDevice = normalized(
      { devices: ["00008140-DIFFERENTDEVICE"] },
      "/p/wrong-device.mobileprovision",
    );
    const { selected, rejected } = selectProvisioningProfile(
      [expired, wrongDevice],
      target,
    );
    expect(selected).toBeNull();
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reasons.length).toBeGreaterThan(0);
    expect(rejected[1].reasons.length).toBeGreaterThan(0);
  });
});

describe("signing identities", () => {
  it("parses security find-identity output", () => {
    const output = `Policy: Code Signing
  Matching identities
  1) ${CERT_SHA1} "Apple Development: Shaw Walters (UT5K5Q5EVF)"
  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Distribution: Other Team (XXXXXXXXXX)"
     2 identities found`;
    const identities = parseCodesigningIdentities(output);
    expect(identities).toEqual([
      { hash: CERT_SHA1, name: "Apple Development: Shaw Walters (UT5K5Q5EVF)" },
      {
        hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        name: "Apple Distribution: Other Team (XXXXXXXXXX)",
      },
    ]);
  });

  it("selects the identity whose cert the profile embeds", () => {
    const identities = [
      { hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", name: "Wrong" },
      { hash: CERT_SHA1, name: "Apple Development: Shaw Walters (UT5K5Q5EVF)" },
    ];
    const identity = selectSigningIdentity(identities, normalized());
    expect(identity?.hash).toBe(CERT_SHA1);
  });

  it("returns null when the profile's cert is not in the keychain", () => {
    expect(
      selectSigningIdentity(
        [{ hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", name: "x" }],
        normalized(),
      ),
    ).toBeNull();
  });
});

describe("deriveSigningEntitlements", () => {
  it("passes exact identifiers through unchanged", () => {
    const entitlements = deriveSigningEntitlements(
      normalized(),
      "ai.elizaos.app",
    );
    expect(entitlements["application-identifier"]).toBe(
      `${TEAM}.ai.elizaos.app`,
    );
    expect(entitlements["get-task-allow"]).toBe(true);
  });

  it("resolves wildcard application-identifier and keychain groups", () => {
    const profile = normalized({ appIdentifier: `${TEAM}.*` });
    const entitlements = deriveSigningEntitlements(
      profile,
      "ai.elizaos.app.WebsiteBlockerContentExtension",
    );
    expect(entitlements["application-identifier"]).toBe(
      `${TEAM}.ai.elizaos.app.WebsiteBlockerContentExtension`,
    );
    expect(entitlements["keychain-access-groups"]).toEqual([
      `${TEAM}.ai.elizaos.app.WebsiteBlockerContentExtension`,
    ]);
  });

  it("does not mutate the profile's own entitlements", () => {
    const profile = normalized({ appIdentifier: `${TEAM}.*` });
    deriveSigningEntitlements(profile, "ai.elizaos.app");
    expect(profile.entitlements["application-identifier"]).toBe(`${TEAM}.*`);
  });
});

describe("buildCodesignPlan", () => {
  it("orders frameworks → dylibs → appexes(+entitlements) → app(+entitlements)", () => {
    const plan = buildCodesignPlan({
      appPath: "/stage/App.app",
      frameworks: ["/stage/App.app/Frameworks/ElizaBunEngine.framework"],
      dylibs: [
        "/stage/App.app/libswift.dylib",
        "/stage/App.app/PlugIns/DeviceActivityMonitorExtension.appex/__preview.dylib",
      ],
      appexes: [
        {
          path: "/stage/App.app/PlugIns/DeviceActivityMonitorExtension.appex",
          entitlementsPath: "/stage/ent-damon.plist",
        },
      ],
      appEntitlementsPath: "/stage/ent-app.plist",
    });
    expect(plan.map((step) => step.path)).toEqual([
      "/stage/App.app/Frameworks/ElizaBunEngine.framework",
      "/stage/App.app/libswift.dylib",
      "/stage/App.app/PlugIns/DeviceActivityMonitorExtension.appex/__preview.dylib",
      "/stage/App.app/PlugIns/DeviceActivityMonitorExtension.appex",
      "/stage/App.app",
    ]);
    expect(plan.at(-2).entitlementsPath).toBe("/stage/ent-damon.plist");
    expect(plan.at(-1).entitlementsPath).toBe("/stage/ent-app.plist");
    expect(
      plan.slice(0, 3).every((step) => step.entitlementsPath === null),
    ).toBe(true);
  });
});

describe("rewriteXctestrunUITargetApp", () => {
  it("rewrites the flat (FormatVersion 1) layout", () => {
    const xctestrun = {
      __xctestrun_metadata__: { FormatVersion: 1 },
      AppUITests: {
        TestHostPath: "__TESTROOT__/Debug-iphoneos/AppUITests-Runner.app",
        UITargetAppPath: "__TESTROOT__/Debug-iphoneos/App.app",
      },
    };
    const count = rewriteXctestrunUITargetApp(xctestrun, "/signed/App.app");
    expect(count).toBe(1);
    expect(xctestrun.AppUITests.UITargetAppPath).toBe("/signed/App.app");
    expect(xctestrun.AppUITests.TestHostPath).toMatch(/AppUITests-Runner/);
  });

  it("rewrites the root-level TestConfigurations (FormatVersion 2) layout xcodebuild actually emits", () => {
    const xctestrun = {
      __xctestrun_metadata__: { FormatVersion: 2 },
      ContainerInfo: { ContainerName: "App", SchemeName: "AppUITests" },
      TestConfigurations: [
        {
          Name: "Test Scheme Action",
          TestTargets: [
            {
              BlueprintName: "AppUITests",
              TestHostPath: "__TESTROOT__/Debug-iphoneos/AppUITests-Runner.app",
              UITargetAppPath: "__TESTROOT__/Debug-iphoneos/App.app",
            },
          ],
        },
      ],
    };
    const count = rewriteXctestrunUITargetApp(xctestrun, "/signed/App.app");
    expect(count).toBe(1);
    expect(xctestrun.TestConfigurations[0].TestTargets[0].UITargetAppPath).toBe(
      "/signed/App.app",
    );
    expect(xctestrun.TestConfigurations[0].TestTargets[0].TestHostPath).toMatch(
      /AppUITests-Runner/,
    );
  });

  it("returns 0 when there is nothing to rewrite", () => {
    expect(rewriteXctestrunUITargetApp({ Foo: { Bar: "baz" } }, "/x")).toBe(0);
  });
});

describe("extractXctestrunAppPaths", () => {
  it("collects TestHostPath + UITargetAppPath from the root-level FormatVersion 2 layout, resolving __TESTROOT__ and deduplicating", () => {
    const xctestrun = {
      __xctestrun_metadata__: { FormatVersion: 2 },
      ContainerInfo: { ContainerName: "App" },
      TestConfigurations: [
        {
          TestTargets: [
            {
              TestHostPath:
                "__TESTROOT__/Debug-iphonesimulator/AppUITests-Runner.app",
              UITargetAppPath: "__TESTROOT__/Debug-iphonesimulator/App.app",
            },
            {
              TestHostPath:
                "__TESTROOT__/Debug-iphonesimulator/AppUITests-Runner.app",
              UITargetAppPath: "/abs/Signed.app",
            },
          ],
        },
      ],
    };
    expect(extractXctestrunAppPaths(xctestrun, "/products")).toEqual([
      "/products/Debug-iphonesimulator/AppUITests-Runner.app",
      "/products/Debug-iphonesimulator/App.app",
      "/abs/Signed.app",
    ]);
  });

  it("collects the flat (FormatVersion 1) layout", () => {
    const xctestrun = {
      __xctestrun_metadata__: { FormatVersion: 1 },
      AppUITests: {
        TestHostPath:
          "__TESTROOT__/Debug-iphonesimulator/AppUITests-Runner.app",
        UITargetAppPath: "__TESTROOT__/Debug-iphonesimulator/App.app",
      },
    };
    expect(extractXctestrunAppPaths(xctestrun, "/products")).toEqual([
      "/products/Debug-iphonesimulator/AppUITests-Runner.app",
      "/products/Debug-iphonesimulator/App.app",
    ]);
  });

  it("returns an empty list for an xctestrun with no app references", () => {
    expect(
      extractXctestrunAppPaths({ __xctestrun_metadata__: {} }, "/products"),
    ).toEqual([]);
  });
});

describe("resolveXctestrunTestRoot", () => {
  it("replaces __TESTROOT__ in nested strings, preserving other value types", () => {
    const when = new Date("2026-07-01T00:00:00Z");
    const blob = new PlistData(Buffer.from("x").toString("base64"));
    const xctestrun = {
      __xctestrun_metadata__: { FormatVersion: 2 },
      AppUITests: {
        TestHostPath: "__TESTROOT__/Debug-iphoneos/AppUITests-Runner.app",
        DependentProductPaths: ["__TESTROOT__/Debug-iphoneos/App.app"],
        IsUITestBundle: true,
        Count: 3,
        When: when,
        Blob: blob,
      },
    };
    const resolved = resolveXctestrunTestRoot(xctestrun, "/dd/Build/Products");
    expect(resolved.AppUITests.TestHostPath).toBe(
      "/dd/Build/Products/Debug-iphoneos/AppUITests-Runner.app",
    );
    expect(resolved.AppUITests.DependentProductPaths).toEqual([
      "/dd/Build/Products/Debug-iphoneos/App.app",
    ]);
    expect(resolved.AppUITests.IsUITestBundle).toBe(true);
    expect(resolved.AppUITests.Count).toBe(3);
    expect(resolved.AppUITests.When).toBe(when);
    expect(resolved.AppUITests.Blob).toBe(blob);
  });
});

describe("device resolution", () => {
  it("resolveDeviceId prefers the flag, falls back to env, else null", () => {
    expect(
      resolveDeviceId({
        flagValue: "abc",
        env: { ELIZA_IOS_DEVICE_ID: "env" },
      }),
    ).toBe("abc");
    expect(
      resolveDeviceId({ flagValue: "  ", env: { ELIZA_IOS_DEVICE_ID: "env" } }),
    ).toBe("env");
    expect(resolveDeviceId({ flagValue: null, env: {} })).toBeNull();
  });

  it("findDeviceRecord matches devicectl identifier, hardware UDID, or name", () => {
    const payload = {
      result: {
        devices: [
          {
            identifier: "59EBB356-BC44-5AA2-91F1-E6AAE756BB86",
            hardwareProperties: { udid: DEVICE_UDID },
            deviceProperties: { name: "MoonCycles" },
          },
        ],
      },
    };
    for (const key of [
      "59ebb356-bc44-5aa2-91f1-e6aae756bb86",
      DEVICE_UDID,
      "MoonCycles",
    ]) {
      const record = findDeviceRecord(payload, key);
      expect(record?.udid).toBe(DEVICE_UDID);
      expect(record?.identifier).toBe("59EBB356-BC44-5AA2-91F1-E6AAE756BB86");
    }
    expect(findDeviceRecord(payload, "nope")).toBeNull();
    expect(findDeviceRecord({}, "anything")).toBeNull();
  });
});

describe("parseCliArgs", () => {
  it("handles --flag value, --flag=value, booleans, and positionals", () => {
    const args = parseCliArgs(
      [
        "--device",
        "abc",
        "--output=/tmp/out",
        "--skip-build",
        "pos",
        "--launch",
      ],
      { booleans: ["skip-build", "launch"] },
    );
    expect(args.device).toBe("abc");
    expect(args.output).toBe("/tmp/out");
    expect(args["skip-build"]).toBe(true);
    expect(args.launch).toBe(true);
    expect(args._).toEqual(["pos"]);
  });

  it("treats a flag before another flag as boolean", () => {
    const args = parseCliArgs(["--pull-boot-trace", "--device", "x"], {
      booleans: [],
    });
    expect(args["pull-boot-trace"]).toBe(true);
    expect(args.device).toBe("x");
  });
});

describe("classifyConsoleExit (#11515)", () => {
  it("flags the SIGTRAP-at-engine-host from the console log text (real devicectl signature)", () => {
    // The real captured signature (d1-boot-trace/README.md): the app dies with
    // "signal 5 (SIGTRAP)" the moment the full-Bun engine host loads. devicectl
    // relays this as a nonzero exit code with signal=null — the case the old
    // ad-hoc check misreported as "phone locked/unpaired".
    const verdict = classifyConsoleExit({
      code: 1,
      signal: null,
      detachRequested: false,
      logText:
        "Launching ai.elizaos.app…\nApp ai.elizaos.app terminated due to signal 5 (SIGTRAP).\n",
    });
    expect(verdict.kind).toBe("sigtrap-engine-host");
    expect(verdict.fatal).toBe(false);
    expect(verdict.message).toContain("#11515");
    expect(verdict.message).toContain("--no-console --pull-boot-trace");
  });

  it("flags the SIGTRAP from an EXC_BREAKPOINT crash note", () => {
    const verdict = classifyConsoleExit({
      code: 1,
      logText: "Thread 5 Crashed: EXC_BREAKPOINT (SIGTRAP) at 0x1042f...",
    });
    expect(verdict.kind).toBe("sigtrap-engine-host");
    expect(verdict.fatal).toBe(false);
  });

  it("flags the SIGTRAP when the child itself is killed by SIGTRAP", () => {
    const verdict = classifyConsoleExit({ code: null, signal: "SIGTRAP" });
    expect(verdict.kind).toBe("sigtrap-engine-host");
  });

  it("does NOT confuse our own 'signal 15' bounded detach for a SIGTRAP", () => {
    // Word-boundary anchoring: "signal 15" must never match the " 5" branch.
    expect(CONSOLE_SIGTRAP_SIGNATURE.test("terminated due to signal 15")).toBe(
      false,
    );
    const verdict = classifyConsoleExit({
      code: null,
      signal: "SIGTERM",
      detachRequested: true,
      logText: "…\nApp terminated due to signal 15.\n",
    });
    expect(verdict.kind).toBe("bounded-detach");
    expect(verdict.fatal).toBe(false);
  });

  it("classifies a devicectl exit-1 after our bounded detach as non-fatal", () => {
    // devicectl can exit 1 (signal null) after relaying our SIGTERM kill —
    // detachRequested is the authoritative signal that this was expected.
    const verdict = classifyConsoleExit({
      code: 1,
      signal: null,
      detachRequested: true,
      logText: "bounded capture window elapsed",
    });
    expect(verdict.kind).toBe("bounded-detach");
    expect(verdict.fatal).toBe(false);
  });

  it("keeps a genuine early exit (locked/unpaired) fatal", () => {
    const verdict = classifyConsoleExit({
      code: 1,
      signal: null,
      detachRequested: false,
      logText: "ERROR: The specified device was not found.",
    });
    expect(verdict.kind).toBe("early-exit");
    expect(verdict.fatal).toBe(true);
    expect(verdict.message).toContain("unlocked");
  });

  it("treats a clean exit as ok", () => {
    const verdict = classifyConsoleExit({ code: 0, signal: null, logText: "" });
    expect(verdict.kind).toBe("ok");
    expect(verdict.fatal).toBe(false);
  });
});

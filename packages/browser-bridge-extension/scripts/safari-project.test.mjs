/**
 * Verifies Safari native-handler project patching against a converter-shaped
 * fixture, including release signing validation and layout-drift failures.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchGeneratedSafariProject,
  resolveSafariNativeConfiguration,
  safariNativeDefaults,
  validateSafariSignedBundleContracts,
} from "./safari-project.mjs";

const temporaryDirectories = [];
const appName = "Agent Browser Bridge";
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function buildConfiguration(id, infoPlist, bundleIdentifier) {
  return `
\t\t${id} = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tINFOPLIST_FILE = "${infoPlist}";
\t\t\t\tMACOSX_DEPLOYMENT_TARGET = 10.14;
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier};
\t\t\t};
\t\t};`;
}

function converterProjectFixture() {
  return `// !$*UTF8*$!
{
\tobjects = {
${buildConfiguration(
  "AAAAAAAAAAAAAAAAAAAAAAAA",
  `${appName}/Info.plist`,
  '"ai.elizaos.browserbridge.Agent-Browser-Bridge"',
)}
${buildConfiguration(
  "BBBBBBBBBBBBBBBBBBBBBBBB",
  `${appName}/Info.plist`,
  '"ai.elizaos.browserbridge.Agent-Browser-Bridge"',
)}
${buildConfiguration(
  "CCCCCCCCCCCCCCCCCCCCCCCC",
  `${appName} Extension/Info.plist`,
  "ai.elizaos.browserbridge.app.Extension",
)}
${buildConfiguration(
  "DDDDDDDDDDDDDDDDDDDDDDDD",
  `${appName} Extension/Info.plist`,
  "ai.elizaos.browserbridge.app.Extension",
)}
\t\tEEEEEEEEEEEEEEEEEEEEEEEE = { ref = FFFFFFFFFFFFFFFFFFFFFFFF; };
\t\t111111111111111111111111 = { ref = 222222222222222222222222; };
\t\t333333333333333333333333 = { ref = 444444444444444444444444; };
\t};
}
`;
}

async function createFixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "browser-bridge-safari-project-"),
  );
  temporaryDirectories.push(directory);
  const projectDirectory = path.join(directory, appName);
  const projectPath = path.join(projectDirectory, `${appName}.xcodeproj`);
  const extensionDirectory = path.join(
    projectDirectory,
    `${appName} Extension`,
  );
  const appDirectory = path.join(projectDirectory, appName);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(extensionDirectory, { recursive: true });
  await fs.mkdir(appDirectory, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, "project.pbxproj"),
    converterProjectFixture(),
  );
  await fs.writeFile(
    path.join(extensionDirectory, "Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>NSExtension</key><dict/></dict></plist>`,
  );
  await fs.writeFile(
    path.join(extensionDirectory, "SafariWebExtensionHandler.swift"),
    "// unsafe converter echo\n",
  );
  const handlerTemplatePath = path.join(directory, "Handler.swift");
  await fs.writeFile(handlerTemplatePath, "// committed secure handler\n");
  return { directory, projectPath, handlerTemplatePath };
}

describe("Safari native configuration", () => {
  it("ships a bounded canonical handler without request or secret logging", async () => {
    const handler = await fs.readFile(
      path.join(
        extensionRoot,
        "safari",
        "native",
        "SafariWebExtensionHandler.swift",
      ),
      "utf8",
    );
    expect(handler).toContain('requestType = "browser_bridge.enroll"');
    expect(handler).toContain('resultType = "browser_bridge.enroll_result"');
    expect(handler).toContain("maximumMessageBytes = 65_536");
    expect(handler).not.toMatch(/os_log|NSLog|print\s*\(/);
    expect(handler).not.toContain('"echo"');
    expect(handler).not.toContain('"brokerAuth"');
    expect(handler).not.toContain('response["message"]');
    expect(handler).not.toMatch(/Keychain|kSecAttr/);
    expect(handler).toContain('sharedSecretName = "s"');
    expect(handler).toContain("Darwin.open(path, O_RDONLY | O_NOFOLLOW)");
    expect(handler).toContain(
      "descriptorMetadata.st_dev == pathMetadata.st_dev",
    );
    expect(handler).toContain(
      "descriptorMetadata.st_ino == pathMetadata.st_ino",
    );
    expect(handler).toContain("descriptorMetadata.st_uid == expectedUid");
    expect(handler).toContain("descriptorMetadata.st_size == 32");
    expect(handler).toContain("lstat(socketPath, &socketMetadata) == 0");
    expect(handler).toContain("socketMetadata.st_uid == getuid()");
    expect(handler).toContain("(socketMetadata.st_mode & 0o777) == 0o600");
    expect(handler.match(/setsockopt\(/g)).toHaveLength(2);
  });

  const macOsIt = process.platform === "darwin" ? it : it.skip;
  macOsIt(
    "matches the desktop broker's cross-language HMAC vector",
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "browser-bridge-safari-hmac-"),
      );
      temporaryDirectories.push(directory);
      const harnessPath = path.join(directory, "HmacHarness.swift");
      const executablePath = path.join(directory, "hmac-harness");
      await fs.writeFile(
        harnessPath,
        `import Foundation

@main
struct HmacHarness {
    static func main() throws {
        let request = ValidatedEnrollmentRequest(
            requestId: "123e4567-e89b-42d3-a456-426614174000",
            nonce: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
            extensionVersion: "1.2.3",
            profileId: "123e4567-e89b-42d3-a456-426614174001",
            dictionary: [:]
        )
        print(try SafariBrokerAuthentication.mac(
            request: request,
            timestampMs: 1_800_000_000_000,
            secret: Data(repeating: 7, count: 32)
        ))
    }
}
`,
      );
      await execFileAsync("xcrun", [
        "swiftc",
        path.join(
          extensionRoot,
          "safari",
          "native",
          "SafariWebExtensionHandler.swift",
        ),
        harnessPath,
        "-framework",
        "SafariServices",
        "-o",
        executablePath,
      ]);
      const { stdout } = await execFileAsync(executablePath);
      expect(stdout.trim()).toBe("flk7dxI31fluBOnI6VeU45TGFie5SZuQ-5b10f_2m7I");
    },
    30_000,
  );

  macOsIt(
    "accepts only the broker's exact private App Group secret file",
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "browser-bridge-safari-secret-"),
      );
      temporaryDirectories.push(directory);
      const harnessPath = path.join(directory, "SecretHarness.swift");
      const executablePath = path.join(directory, "secret-harness");
      await fs.writeFile(
        harnessPath,
        `import Darwin
import Foundation

@main
struct SecretHarness {
    static func accepted(_ path: String, uid: uid_t = getuid()) -> Bool {
        do {
            let value = try DesktopBrokerRelay.readBrokerCredential(path: path, expectedUid: uid)
            return value == Data(repeating: 7, count: 32)
        } catch {
            return false
        }
    }

    static func write(_ path: String, count: Int, mode: mode_t) {
        FileManager.default.createFile(
            atPath: path,
            contents: Data(repeating: 7, count: count),
            attributes: [.posixPermissions: NSNumber(value: mode)]
        )
        precondition(chmod(path, mode) == 0)
    }

    static func main() throws {
        let root = CommandLine.arguments[1]
        let valid = root + "/valid"
        write(valid, count: 32, mode: 0o600)
        precondition(accepted(valid))

        let short = root + "/short"
        write(short, count: 31, mode: 0o600)
        precondition(!accepted(short))

        let long = root + "/long"
        write(long, count: 33, mode: 0o600)
        precondition(!accepted(long))

        let publicFile = root + "/public"
        write(publicFile, count: 32, mode: 0o644)
        precondition(!accepted(publicFile))

        let link = root + "/link"
        precondition(symlink(valid, link) == 0)
        precondition(!accepted(link))
        precondition(!accepted(valid, uid: getuid() &+ 1))
        precondition(!accepted(root))
        print("shared-secret-validation-ok")
    }
}
`,
      );
      await execFileAsync("xcrun", [
        "swiftc",
        path.join(
          extensionRoot,
          "safari",
          "native",
          "SafariWebExtensionHandler.swift",
        ),
        harnessPath,
        "-framework",
        "SafariServices",
        "-o",
        executablePath,
      ]);
      const { stdout } = await execFileAsync(executablePath, [directory]);
      expect(stdout.trim()).toBe("shared-secret-validation-ok");
    },
    30_000,
  );

  macOsIt(
    "accepts broker RFC3339 milliseconds and enforces bounded native token expiry",
    async () => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "browser-bridge-safari-response-"),
      );
      temporaryDirectories.push(directory);
      const harnessPath = path.join(directory, "ResponseHarness.swift");
      const executablePath = path.join(directory, "response-harness");
      await fs.writeFile(
        harnessPath,
        `import Foundation

@main
struct ResponseHarness {
    static let request = ValidatedEnrollmentRequest(
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        nonce: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
        extensionVersion: "1.2.3",
        profileId: "123e4567-e89b-42d3-a456-426614174001",
        dictionary: [:]
    )

    static func response(issuedAt: String, expiresAt: Any) throws -> [String: Any] {
        let value: [String: Any] = [
            "v": 1,
            "type": "browser_bridge.enroll_result",
            "requestId": request.requestId,
            "nonce": request.nonce,
            "issuedAt": issuedAt,
            "config": [
                "apiBaseUrl": "http://127.0.0.1:3210",
                "companionId": "desktop-companion",
                "pairingToken": "secret-token",
                "pairingTokenExpiresAt": expiresAt,
                "browser": "safari",
                "profileId": request.profileId,
                "profileLabel": "Safari profile",
                "label": "Local Eliza",
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func isAccepted(issuedAt: String, expiresAt: Any) -> Bool {
        do {
            _ = try SafariNativeResponseValidator.validate(
                try response(issuedAt: issuedAt, expiresAt: expiresAt),
                request: request
            )
            return true
        } catch {
            return false
        }
    }

    static func main() {
        precondition(isAccepted(
            issuedAt: "2027-01-02T03:04:05.123Z",
            expiresAt: "2027-01-02T03:09:05.123Z"
        ))
        precondition(isAccepted(
            issuedAt: "2027-01-02T03:04:05Z",
            expiresAt: "2027-01-02T03:09:05Z"
        ))
        precondition(!isAccepted(
            issuedAt: "2027-01-02T03:04:05.123Z",
            expiresAt: NSNull()
        ))
        precondition(!isAccepted(
            issuedAt: "2027-01-02T03:04:05.123Z",
            expiresAt: "2027-01-02T03:09:05.124Z"
        ))
        precondition(!isAccepted(
            issuedAt: "2027-01-02 03:04:05.123Z",
            expiresAt: "2027-01-02T03:09:05.123Z"
        ))
        print("broker-response-validation-ok")
    }
}
`,
      );
      await execFileAsync("xcrun", [
        "swiftc",
        path.join(
          extensionRoot,
          "safari",
          "native",
          "SafariWebExtensionHandler.swift",
        ),
        harnessPath,
        "-framework",
        "SafariServices",
        "-o",
        executablePath,
      ]);
      const { stdout } = await execFileAsync(executablePath);
      expect(stdout.trim()).toBe("broker-response-validation-ok");
    },
    30_000,
  );

  it("uses deterministic development defaults", () => {
    expect(resolveSafariNativeConfiguration({})).toMatchObject({
      release: false,
      signingTeam: null,
      signingIdentity: null,
      appGroup: safariNativeDefaults.appGroup,
      socketName: safariNativeDefaults.socketName,
    });
  });

  it("fails release packaging before conversion when signing inputs are incomplete", () => {
    expect(() =>
      resolveSafariNativeConfiguration({ ELIZA_SAFARI_RELEASE: "1" }),
    ).toThrow(/explicit signed configuration/);
    expect(() =>
      resolveSafariNativeConfiguration({
        ELIZA_SAFARI_SIGNING_TEAM: "ABCDEFGHIJ",
      }),
    ).toThrow(/must be supplied together/);
    expect(() =>
      resolveSafariNativeConfiguration({
        ELIZA_SAFARI_APP_GROUP: "../../unsafe",
      }),
    ).toThrow(/invalid value/);
  });

  it("validates both embedded profiles and both signed App Group entitlements", () => {
    const configuration = resolveSafariNativeConfiguration({
      ELIZA_SAFARI_RELEASE: "1",
      ELIZA_SAFARI_SIGNING_TEAM: "ABCDEFGHIJ",
      ELIZA_SAFARI_SIGNING_IDENTITY: "Apple Distribution",
      ELIZA_SAFARI_APP_GROUP: safariNativeDefaults.appGroup,
      ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER: "App Profile",
      ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER:
        "Extension Profile",
    });
    const entitlements = (bundleIdentifier) => ({
      "com.apple.application-identifier": `ABCDEFGHIJ.${bundleIdentifier}`,
      "com.apple.security.application-groups": [safariNativeDefaults.appGroup],
    });
    const profile = (bundleIdentifier, name) => ({
      Name: name,
      TeamIdentifier: ["ABCDEFGHIJ"],
      ExpirationDate: "2030-01-01T00:00:00.000Z",
      Entitlements: {
        "application-identifier": `ABCDEFGHIJ.${bundleIdentifier}`,
        "com.apple.security.application-groups": [
          safariNativeDefaults.appGroup,
        ],
      },
    });
    const contract = {
      configuration,
      appEntitlements: entitlements("ai.elizaos.browserbridge.app"),
      extensionEntitlements: entitlements(
        "ai.elizaos.browserbridge.app.Extension",
      ),
      appProfile: profile("ai.elizaos.browserbridge.app", "App Profile"),
      extensionProfile: profile(
        "ai.elizaos.browserbridge.app.Extension",
        "Extension Profile",
      ),
      bundleIdentifier: "ai.elizaos.browserbridge.app",
      now: Date.parse("2029-01-01T00:00:00.000Z"),
    };
    expect(() => validateSafariSignedBundleContracts(contract)).not.toThrow();
    expect(() =>
      validateSafariSignedBundleContracts({
        ...contract,
        extensionEntitlements: {
          ...contract.extensionEntitlements,
          "com.apple.security.application-groups": ["group.attacker"],
        },
      }),
    ).toThrow(/exact App Group/);
    expect(() =>
      validateSafariSignedBundleContracts({
        ...contract,
        appProfile: { ...contract.appProfile, Name: "Wrong Profile" },
      }),
    ).toThrow(/embedded provisioning profile/);
  });
});

describe("Safari converter project patch", () => {
  it("replaces the echo handler and adds deterministic native entitlements", async () => {
    const fixture = await createFixture();
    const configuration = resolveSafariNativeConfiguration({
      ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER: "App Profile",
      ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER:
        "Extension Profile",
    });
    const result = await patchGeneratedSafariProject({
      projectPath: fixture.projectPath,
      appName,
      bundleIdentifier: "ai.elizaos.browserbridge.app",
      marketingVersion: "2.0.3",
      buildVersion: "20003040007",
      deploymentTarget: "14.0",
      configuration,
      handlerTemplatePath: fixture.handlerTemplatePath,
    });

    await expect(fs.readFile(result.generatedHandler, "utf8")).resolves.toBe(
      "// committed secure handler\n",
    );
    const project = await fs.readFile(result.projectFile, "utf8");
    expect(project.match(/MARKETING_VERSION = 2\.0\.3;/g)).toHaveLength(4);
    expect(
      project.match(/CURRENT_PROJECT_VERSION = 20003040007;/g),
    ).toHaveLength(4);
    expect(project.match(/MACOSX_DEPLOYMENT_TARGET = 14\.0;/g)).toHaveLength(4);
    expect(project.match(/CODE_SIGN_ENTITLEMENTS =/g)).toHaveLength(4);
    expect(project.match(/PROVISIONING_PROFILE_SPECIFIER =/g)).toHaveLength(4);
    expect(project).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
    const extensionInfo = await fs.readFile(result.extensionInfoPlist, "utf8");
    expect(extensionInfo).toContain(
      `<string>${safariNativeDefaults.appGroup}</string>`,
    );
    expect(extensionInfo).not.toMatch(/Keychain|keychain/);
    for (const entitlementPath of [
      result.appEntitlements,
      result.extensionEntitlements,
    ]) {
      const entitlements = await fs.readFile(entitlementPath, "utf8");
      expect(entitlements).toContain(safariNativeDefaults.appGroup);
      expect(entitlements).not.toContain("keychain-access-groups");
    }
  });

  it("fails closed when the converter project shape drifts", async () => {
    const fixture = await createFixture();
    const projectFile = path.join(fixture.projectPath, "project.pbxproj");
    await fs.writeFile(
      projectFile,
      converterProjectFixture().replace("MARKETING_VERSION = 1.0;", ""),
    );
    await expect(
      patchGeneratedSafariProject({
        projectPath: fixture.projectPath,
        appName,
        bundleIdentifier: "ai.elizaos.browserbridge.app",
        marketingVersion: "2.0.3",
        buildVersion: "20003040007",
        deploymentTarget: "14.0",
        configuration: resolveSafariNativeConfiguration({}),
        handlerTemplatePath: fixture.handlerTemplatePath,
      }),
    ).rejects.toThrow(/layout drifted/);
  });
});

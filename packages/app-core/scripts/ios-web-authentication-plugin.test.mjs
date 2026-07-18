/**
 * Locks the iOS Cloud-auth bridge, Keychain policy, project membership, and
 * canonical-to-generated synchronization invariants with source fixtures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { syncPlatformTemplateFiles } from "./lib/capacitor-platform-templates.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "../../..");
const iosTemplateRoot = path.join(
  repoRoot,
  "packages/app-core/platforms/ios/App",
);
const canonicalPath = path.join(
  iosTemplateRoot,
  "App/ElizaWebAuthenticationPlugin.swift",
);
const canonicalSource = fs.readFileSync(canonicalPath, "utf8");
const bridgeControllerPath = path.join(
  iosTemplateRoot,
  "App/ElizaBridgeViewController.swift",
);
const bridgeControllerSource = fs.readFileSync(bridgeControllerPath, "utf8");
const projectSource = fs.readFileSync(
  path.join(iosTemplateRoot, "App.xcodeproj/project.pbxproj"),
  "utf8",
);
const podfileSource = fs.readFileSync(
  path.join(iosTemplateRoot, "Podfile"),
  "utf8",
);
const tempDirs = [];

function methodSource(source, name, nextName) {
  const start = source.indexOf(`@objc public func ${name}`);
  const nextMarker =
    nextName === "finishAuthorizationSession"
      ? "private func finishAuthorizationSession"
      : `@objc public func ${nextName}`;
  const end = source.indexOf(nextMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Unable to isolate Swift method ${name}`);
  }
  return source.slice(start, end);
}

function auditSource(source) {
  const deleteCredential = methodSource(
    source,
    "deleteCredential",
    "storeAuthorizationState",
  );
  const deleteAuthorizationState = methodSource(
    source,
    "deleteAuthorizationState",
    "finishAuthorizationSession",
  );
  const accessibilityMatches =
    source.match(/kSecAttrAccessibleWhenUnlockedThisDeviceOnly/g) ?? [];

  return {
    canonicalBoundary:
      source.includes('"production": "elizacloud.ai"') &&
      source.includes('"staging": "staging.elizacloud.ai"') &&
      source.includes(
        'private static let authorizationPath = "/app-auth/authorize"',
      ) &&
      source.includes('private static let callbackHost = "eliza.app"') &&
      source.includes('private static let callbackPath = "/auth/callback"') &&
      source.includes(
        'private static let redirectUri = "https://eliza.app/auth/callback"',
      ) &&
      source.includes('query["code_challenge_method"] == "S256"') &&
      !source.includes("*.elizacloud.ai"),
    conditionalAuthorizationDelete:
      deleteAuthorizationState.includes(
        'let expectedState = call.getString("expectedState")',
      ) &&
      deleteAuthorizationState.includes(
        "matches(expectedState, pattern: Self.pkceValuePattern)",
      ) &&
      /guard let storedValue = try storedAuthorizationState\(environment: environment\) else \{\s*call\.resolve\(\["deleted": true\]\)\s*return\s*\}/s.test(
        deleteAuthorizationState,
      ) &&
      deleteAuthorizationState.includes(
        'let storedState = record["state"] as? String',
      ) &&
      deleteAuthorizationState.includes("storedState == expectedState") &&
      deleteAuthorizationState.includes(
        "Refusing to delete a different Cloud authorization state",
      ),
    credentialDeleteIsAbsentSafe:
      deleteCredential.includes(
        "if let storedCredentialId = try storedCredentialId(",
      ) &&
      deleteCredential.includes("storedCredentialId == expectedCredentialId") &&
      deleteCredential.includes(
        "status == errSecSuccess || status == errSecItemNotFound",
      ) &&
      source.includes(
        'let credentialId = credential["credentialId"] as? String',
      ) &&
      source.includes(
        'throw validationError("Stored Cloud credential ID is invalid")',
      ),
    generationSafeCompletion:
      source.includes("private var activeSessionGeneration: UUID?") &&
      source.includes(
        "private var sessionContextsByGeneration: [UUID: AuthorizationSessionContext] = [:]",
      ) &&
      /guard let self,\s*self\.finishAuthorizationSession\(generation: generation\)/s.test(
        source,
      ) &&
      /if activeSessionGeneration == generation \{\s*activeSessionGeneration = nil\s*\}/s.test(
        source,
      ) &&
      !source.includes("self?.activeSession = nil"),
    retainedSafePresentationAnchor:
      source.includes(
        "guard let presentationWindow = self.presentationWindow() else",
      ) &&
      source.includes("private final class AuthorizationPresentationContext") &&
      source.includes("ASWebAuthenticationPresentationContextProviding") &&
      source.includes("self.presentationWindow = presentationWindow") &&
      source.includes(
        "session.presentationContextProvider = presentationContext",
      ) &&
      source.includes("presentationContext: presentationContext") &&
      !source.includes("preconditionFailure("),
    unlockedOnlyKeychain:
      accessibilityMatches.length === 2 &&
      !source.includes("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("native iOS Cloud-auth bridge source contract", () => {
  it("materializes the exact canonical bridge through platform sync", () => {
    const appDirValue = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-ios-auth-template-"),
    );
    tempDirs.push(appDirValue);
    syncPlatformTemplateFiles("ios", {
      appDirValue,
      log: () => {},
      repoRootValue: repoRoot,
    });
    const stagedPath = path.join(
      appDirValue,
      "ios/App/App/ElizaWebAuthenticationPlugin.swift",
    );
    const stagedControllerPath = path.join(
      appDirValue,
      "ios/App/App/ElizaBridgeViewController.swift",
    );
    expect(fs.readFileSync(stagedPath, "utf8")).toBe(canonicalSource);
    expect(fs.readFileSync(stagedControllerPath, "utf8")).toBe(
      bridgeControllerSource,
    );
  });

  it("registers and compiles the plugin in the app target", () => {
    expect(bridgeControllerSource).toContain(
      "bridge.registerPluginInstance(ElizaWebAuthenticationPlugin())",
    );
    expect(projectSource).toContain(
      "ElizaWebAuthenticationPlugin.swift in Sources",
    );
    expect(projectSource).toContain(
      "path = ElizaWebAuthenticationPlugin.swift;",
    );
  });

  it("pins the project and generated Podfile floor to iOS 17.4", () => {
    const deploymentTargets = [
      ...projectSource.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g),
    ].map((match) => match[1]);
    expect(deploymentTargets.length).toBeGreaterThan(0);
    expect(new Set(deploymentTargets)).toEqual(new Set(["17.4"]));
    expect(podfileSource).toContain("platform :ios, '17.4'");
  });

  it("pins authorization, callback, PKCE, and credential hosts exactly", () => {
    expect(auditSource(canonicalSource).canonicalBoundary).toBe(true);
  });

  it("preserves a newer session when an older canceled session completes", () => {
    expect(auditSource(canonicalSource).generationSafeCompletion).toBe(true);

    const vulnerableFixture = canonicalSource.replace(
      `        if activeSessionGeneration == generation {
            activeSessionGeneration = nil
        }`,
      "        activeSessionGeneration = nil",
    );
    expect(vulnerableFixture).not.toBe(canonicalSource);
    expect(auditSource(vulnerableFixture).generationSafeCompletion).toBe(false);
  });

  it("retains the validated anchor and has a non-crashing fallback", () => {
    expect(auditSource(canonicalSource).retainedSafePresentationAnchor).toBe(
      true,
    );

    const vulnerableFixture = canonicalSource.replace(
      "presentationContext: presentationContext",
      "presentationContext: AuthorizationPresentationContext(presentationWindow: UIWindow())",
    );
    expect(auditSource(vulnerableFixture).retainedSafePresentationAnchor).toBe(
      false,
    );
  });

  it("makes exact credential deletion idempotent only when the slot is absent", () => {
    expect(auditSource(canonicalSource).credentialDeleteIsAbsentSafe).toBe(
      true,
    );

    const rejectMissingFixture = canonicalSource.replace(
      "if let storedCredentialId = try storedCredentialId(",
      "guard let storedCredentialId = try storedCredentialId(",
    );
    expect(auditSource(rejectMissingFixture).credentialDeleteIsAbsentSafe).toBe(
      false,
    );
  });

  it("conditionally deletes only the matching authorization generation", () => {
    expect(auditSource(canonicalSource).conditionalAuthorizationDelete).toBe(
      true,
    );

    const unconditionalFixture = canonicalSource.replace(
      'let expectedState = call.getString("expectedState")',
      'let ignoredState = call.getString("expectedState")',
    );
    expect(
      auditSource(unconditionalFixture).conditionalAuthorizationDelete,
    ).toBe(false);
  });

  it("keeps credentials and PKCE recovery state inaccessible while locked", () => {
    expect(auditSource(canonicalSource).unlockedOnlyKeychain).toBe(true);

    const backgroundReadableFixture = canonicalSource.replaceAll(
      "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
      "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
    );
    expect(auditSource(backgroundReadableFixture).unlockedOnlyKeychain).toBe(
      false,
    );
  });
});

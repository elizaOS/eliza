// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { AdbFlasherBackend } from "./adb-backend";
import {
  describeSignedRelease,
  type SignedReleaseDescription,
  signedReleaseFiles,
} from "./signed-release";

vi.mock("./signed-release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signed-release")>()),
  describeSignedRelease: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function description(): SignedReleaseDescription {
  return {
    subjectSha256: "a".repeat(64),
    issuedAt: "2026-09-25T00:00:00Z",
    release: {
      releaseId: "signed-release",
      version: "1.0.0",
      channel: "canary",
      operation: "os-install",
      target: {
        id: "pixel11pro-grizzly",
        codename: "grizzly",
        kind: "physical",
        architecture: "arm64",
      },
      files: [
        { filename: "boot.img", sha256: "b".repeat(64), sizeBytes: 20 },
        {
          filename: "fastboot-info.txt",
          sha256: "c".repeat(64),
          sizeBytes: 30,
        },
      ],
      startingStates: [
        {
          recovery: {
            archive: {
              filename: "stock.zip",
              sha256: "d".repeat(64),
              sizeBytes: 40,
            },
          },
        },
      ],
    },
  };
}

function discovery(bytes: string) {
  const base = "https://github.com/elizaOS/os/releases/download/v1/";
  const names = [
    "android-release-manifest-grizzly.json",
    "boot.img",
    "fastboot-info.txt",
    "stock.zip",
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "https://api.github.com/repos/elizaOS/os/releases") {
        return new Response(
          JSON.stringify([
            {
              assets: names.map((name) => ({
                name,
                browser_download_url: base + name,
              })),
            },
          ]),
        );
      }
      if (url === base + names[0]) return new Response(bytes);
      throw new Error(`Unexpected download ${url}`);
    }),
  );
}

test("discovery keeps exact signed bytes and all install and recovery contracts", async () => {
  const bytes = '{\n "schemaVersion": 2, "fixture": true\n}\n';
  const metadata = description();
  vi.mocked(describeSignedRelease).mockResolvedValue(metadata);
  discovery(bytes);
  const [build] = await new AdbFlasherBackend().listBuilds();
  expect(describeSignedRelease).toHaveBeenCalledWith(bytes);
  expect(build?.signedManifest).toBe(bytes);
  expect(build?.signedFiles?.map((file) => file.filename)).toEqual([
    "boot.img",
    "fastboot-info.txt",
    "stock.zip",
  ]);
  expect(build?.sizeBytes).toBe(90);
  expect(build?.channel).toBe("nightly");
  expect(build?.architecture).toBe("arm64-v8a");
  expect(build?.manifest).toBeUndefined();
});

test("discovery propagates canonical authorization failure", async () => {
  discovery('{"schemaVersion":1}');
  vi.mocked(describeSignedRelease).mockRejectedValue(
    new Error("fixture authorization rejected"),
  );
  await expect(new AdbFlasherBackend().listBuilds()).rejects.toThrow(
    "fixture authorization rejected",
  );
});

test("reused recovery files are deduplicated only for identical contracts", () => {
  const metadata = description();
  const state = metadata.release.startingStates[0];
  if (!state) throw new Error("Missing fixture state");
  metadata.release.startingStates.push(structuredClone(state));
  expect(signedReleaseFiles(metadata)).toHaveLength(3);
  state.recovery.archive.filename = "boot.img";
  expect(() => signedReleaseFiles(metadata)).toThrow(
    "Conflicting signed file contracts",
  );
});

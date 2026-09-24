/**
 * Contract tests for verify-grizzly-artifacts.mjs: attestation must fail
 * closed whenever the staged product output disagrees with the prepare stamp,
 * and the flash-host check must refuse any image whose bytes differ from the
 * attested build.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "../..");
const script = join(
  repositoryRoot,
  "scripts/distro-android/verify-grizzly-artifacts.mjs",
);

function run(args: string[]) {
  return spawnSync("node", [script, ...args], { encoding: "utf8" });
}

const STOCK_FSTAB_DATA_LINE =
  "/dev/block/by-name/userdata /data f2fs noatime,nosuid,nodev " +
  "latemount,wait,check,quota,formattable,fileencryption=aes-256-xts," +
  "metadata_encryption=aes-256-xts,keydirectory=/metadata/vold/metadata_encryption\n";

function scaffoldAospRoot(options: {
  stamp?: Record<string, unknown> | null;
  backendLine?: string;
  graphiteLine?: string;
  eglLine?: string;
  fstabLine?: string;
  probeRc?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "elizaos-grizzly-attest-"));
  const productDir = join(root, "out/target/product/grizzly");
  const vendorDir = join(productDir, "vendor");
  mkdirSync(join(productDir, "system/etc/init/hw"), { recursive: true });
  writeFileSync(
    join(productDir, "system/etc/init/hw/init.rc"),
    "on post-fs-data\n    exec - system system -- /system/bin/vdc keymaster earlyBootEnded\n",
  );
  mkdirSync(join(vendorDir, "etc/init/hw"), { recursive: true });
  const stampDir = join(root, "vendor/google_devices/grizzly");
  mkdirSync(stampDir, { recursive: true });
  if (options.stamp !== null) {
    writeFileSync(
      join(stampDir, ".elizaos-prepare-stamp.json"),
      JSON.stringify(
        options.stamp ?? {
          renderengineBackend: null,
          renderengineGraphite: true,
          eglSelection: null,
          earlyBootProbes: false,
          conservativeF2fs: false,
        },
      ),
    );
  }
  const propLines = [
    options.backendLine ?? "",
    options.graphiteLine ?? "debug.renderengine.graphite=true",
    options.eglLine ?? "persist.graphics.egl=angle",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(vendorDir, "build.prop"), `${propLines}\n`);
  writeFileSync(
    join(vendorDir, "etc/fstab.malibu"),
    options.fstabLine ?? STOCK_FSTAB_DATA_LINE,
  );
  if (options.probeRc) {
    writeFileSync(
      join(vendorDir, "etc/init/hw/init.elizaos-debug.rc"),
      'on post-fs\n    write /dev/kmsg "elizaos-init: post-fs reached"\n',
    );
  }
  const requiredImages = [
    "boot.img",
    "init_boot.img",
    "dtbo.img",
    "vendor_kernel_boot.img",
    "pvmfw.img",
    "vendor_boot.img",
    "vbmeta.img",
    "system.img",
    "system_ext.img",
    "product.img",
    "vendor.img",
    "vendor_dlkm.img",
    "system_dlkm.img",
    "system_other.img",
    "super_empty.img",
  ];
  for (const image of requiredImages) {
    writeFileSync(
      join(productDir, image),
      image === "vendor.img" ? "vendor-image-bytes" : `${image}-bytes`,
    );
  }
  for (const partition of ["vendor", "system"]) {
    execFileSync(
      "mkfs.ext4",
      [
        "-q",
        "-F",
        "-d",
        join(productDir, partition),
        join(productDir, `${partition}.img`),
        "4096",
      ],
      { stdio: "pipe" },
    );
  }
  return { root, productDir };
}

describe("verify-grizzly-artifacts attest", () => {
  test("rejects packaged content mismatch even when staging and timestamps agree", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      const payload = join(root, "wrong.prop");
      writeFileSync(
        payload,
        "debug.renderengine.graphite=false\npersist.graphics.egl=angle\n",
      );
      const image = join(productDir, "vendor.img");
      execFileSync("debugfs", ["-w", "-R", "rm /build.prop", image], {
        stdio: "pipe",
      });
      execFileSync(
        "debugfs",
        ["-w", "-R", `write ${payload} /build.prop`, image],
        { stdio: "pipe" },
      );
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("packaged vendor build.prop graphite");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attests packaged images after staging cleanup and rejects missing init", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      rmSync(join(productDir, "vendor"), { recursive: true });
      rmSync(join(productDir, "system"), { recursive: true });
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      execFileSync(
        "debugfs",
        ["-w", "-R", "rm /etc/init/hw/init.rc", join(productDir, "system.img")],
        { stdio: "pipe" },
      );
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("system init.rc unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects stale system staging and unattested extra images", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(0);
      writeFileSync(join(productDir, "stray.img"), "unreviewed");
      const check = run([
        "check",
        "--manifest",
        join(productDir, "grizzly-artifacts.json"),
        "--artifact-dir",
        productDir,
      ]);
      expect(check.status).toBe(1);
      expect(check.stderr).toContain("unattested images");
      mkdirSync(join(productDir, "system"), { recursive: true });
      writeFileSync(join(productDir, "system", "changed"), "new input");
      utimesSync(join(productDir, "system.img"), new Date(0), new Date(0));
      const stale = run(["attest", "--aosp-root", root]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("system.img is older");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("attests a coherent build and writes the sha256 manifest", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(0);
      const manifest = JSON.parse(
        require("node:fs").readFileSync(
          join(productDir, "grizzly-artifacts.json"),
          "utf8",
        ),
      );
      expect(manifest.device).toBe("grizzly");
      expect(manifest.prepareStamp.conservativeF2fs).toBe(false);
      const expected = createHash("sha256")
        .update(readFileSync(join(productDir, "vendor.img")))
        .digest("hex");
      expect(manifest.images["vendor.img"].sha256).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attests device-only symlinks without following them on the host and still rejects stale images", () => {
    const { root, productDir } = scaffoldAospRoot({});
    try {
      const vendorLib = join(productDir, "vendor/lib");
      mkdirSync(vendorLib, { recursive: true });
      symlinkSync("/vendor_dlkm/lib/modules", join(vendorLib, "modules"));
      const vendorImage = join(productDir, "vendor.img");
      execFileSync(
        "mkfs.ext4",
        ["-q", "-F", "-d", join(productDir, "vendor"), vendorImage, "4096"],
        { stdio: "pipe" },
      );
      const current = run(["attest", "--aosp-root", root]);
      expect(current.status).toBe(0);
      expect(current.stderr).not.toContain("ENOENT");
      utimesSync(vendorImage, new Date(0), new Date(0));
      const stale = run(["attest", "--aosp-root", root]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain(
        "vendor.img is older than the staged vendor tree",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when there is no prepare stamp", () => {
    const { root } = scaffoldAospRoot({ stamp: null });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prepare stamp missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the staged backend contradicts the stamp (the skiavk-that-was-GL bug)", () => {
    const { root } = scaffoldAospRoot({
      stamp: {
        renderengineBackend: "skiavkthreaded",
        renderengineGraphite: false,
        earlyBootProbes: false,
        conservativeF2fs: false,
      },
      graphiteLine: "debug.renderengine.graphite=false",
      // staged image has no backend override at all
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("would not run the intended renderer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when stock fstab stance lost the factory encryption contract", () => {
    const { root } = scaffoldAospRoot({
      fstabLine:
        "/dev/block/by-name/userdata /data f2fs noatime latemount,wait,check\n",
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("factory encryption contract");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the native-EGL stamp still stages the ANGLE selection", () => {
    const { root } = scaffoldAospRoot({
      stamp: {
        renderengineBackend: "skiaglthreaded",
        renderengineGraphite: false,
        eglSelection: "native",
        earlyBootProbes: false,
        conservativeF2fs: false,
      },
      backendLine: "debug.renderengine.backend=skiaglthreaded",
      graphiteLine: "debug.renderengine.graphite=false",
      // eglLine defaults to the stock ANGLE selection — the mismatch
    });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("still routes through ANGLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when probes are staged but the stamp says probes are off", () => {
    const { root } = scaffoldAospRoot({ probeRc: true });
    try {
      const result = run(["attest", "--aosp-root", root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("earlyBootProbes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify-grizzly-artifacts check", () => {
  test("refuses a self-consistent but truncated attestation manifest", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "grizzly-partial-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.images = { "boot.img": manifest.images["boot.img"] };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(
        join(artifactDir, "boot.img"),
        readFileSync(join(productDir, "boot.img")),
      );
      const result = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("manifest omits required images");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
  test("verifies matching images and refuses tampered bytes", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-check-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      const manifest = JSON.parse(
        require("node:fs").readFileSync(manifestPath, "utf8"),
      );
      for (const image of Object.keys(manifest.images)) {
        writeFileSync(
          join(artifactDir, image),
          require("node:fs").readFileSync(join(productDir, image)),
        );
      }
      const ok = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain(
        "device compatibility and flash authorization remain separate checks",
      );

      writeFileSync(join(artifactDir, "vendor.img"), "DIFFERENT-bytes");
      const tampered = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain("NOT the attested build");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("refuses an artifact dir missing an attested image", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-miss-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      writeFileSync(join(artifactDir, "system.img"), "system-image-bytes");
      const result = run([
        "check",
        "--manifest",
        join(productDir, "grizzly-artifacts.json"),
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing from artifact dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("refuses unsafe manifest image paths before reading outside the artifact dir", () => {
    const { root, productDir } = scaffoldAospRoot({});
    const artifactDir = mkdtempSync(join(tmpdir(), "elizaos-grizzly-unsafe-"));
    try {
      expect(run(["attest", "--aosp-root", root]).status).toBe(0);
      const manifestPath = join(productDir, "grizzly-artifacts.json");
      const manifest = JSON.parse(
        require("node:fs").readFileSync(manifestPath, "utf8"),
      );
      manifest.images = { "../outside.img": manifest.images["system.img"] };
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const result = run([
        "check",
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

/**
 * Exercises the evidence-capture ffmpeg resolver without touching the host
 * package manager. The tests inject process and command dependencies so install
 * decisions can be asserted deterministically.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFfmpegResolver } from "./ffmpeg.mjs";

function makeResolver({
  env = {},
  platform = "linux",
  getuid = () => 0,
  aptGet = true,
  sudo = false,
  bundled = null,
  bundledExists = true,
  bundledWorks = true,
  ffmpegInitiallyWorks = false,
} = {}) {
  const execCalls = [];
  const logMessages = [];
  let ffmpegWorks = ffmpegInitiallyWorks;

  const resolver = createFfmpegResolver({
    env,
    execFileSync(command, args) {
      execCalls.push([command, args]);
      if (args.includes("install") && args.includes("ffmpeg")) {
        ffmpegWorks = true;
      }
    },
    existsSync(candidate) {
      return bundledExists && candidate === bundled;
    },
    getuid,
    platform,
    require(name) {
      if (name !== "ffmpeg-static" || bundled === null) {
        throw new Error(`missing ${name}`);
      }
      return bundled;
    },
    spawnSync(command, args) {
      if (args[0] === "-version") {
        if (command === "ffmpeg") return { status: ffmpegWorks ? 0 : 1 };
        if (command === bundled) return { status: bundledWorks ? 0 : 1 };
        if (command === env.ELIZA_FFMPEG_BIN) return { status: 0 };
        return { status: 1 };
      }
      if (command === "apt-get" && args[0] === "--version") {
        return { status: aptGet ? 0 : 1 };
      }
      if (command === "sudo" && args.join(" ") === "-n true") {
        return { status: sudo ? 0 : 1 };
      }
      return { status: 1 };
    },
  });

  return {
    execCalls,
    logMessages,
    resolve() {
      return resolver.resolveRequiredFfmpeg({
        log(message) {
          logMessages.push(message);
        },
      });
    },
  };
}

test("returns a configured invocable ffmpeg path", () => {
  const { resolve } = makeResolver({
    env: { ELIZA_FFMPEG_BIN: "/opt/ffmpeg" },
  });

  assert.equal(resolve(), "/opt/ffmpeg");
});

test("uses a bundled static binary before installing a system package", () => {
  const { execCalls, resolve } = makeResolver({
    bundled: "/cache/ffmpeg-static/ffmpeg",
  });

  assert.equal(resolve(), "/cache/ffmpeg-static/ffmpeg");
  assert.deepEqual(execCalls, []);
});

test("installs ffmpeg with apt-get as root when no binary is available", () => {
  const { execCalls, logMessages, resolve } = makeResolver();

  assert.equal(resolve(), "ffmpeg");
  assert.deepEqual(execCalls, [
    ["apt-get", ["update"]],
    ["apt-get", ["install", "-y", "ffmpeg"]],
  ]);
  assert.deepEqual(logMessages, ["ffmpeg missing; installing via apt-get."]);
});

test("installs ffmpeg with sudo apt-get when non-root sudo is available", () => {
  const { execCalls, resolve } = makeResolver({
    getuid: () => 1000,
    sudo: true,
  });

  assert.equal(resolve(), "ffmpeg");
  assert.deepEqual(execCalls, [
    ["sudo", ["apt-get", "update"]],
    ["sudo", ["apt-get", "install", "-y", "ffmpeg"]],
  ]);
});

test("fails loudly when Linux install needs unavailable sudo", () => {
  const { resolve } = makeResolver({ getuid: () => 1000 });

  assert.throws(resolve, /apt-get needs sudo privileges/);
});

test("fails loudly on unsupported platforms", () => {
  const { resolve } = makeResolver({ platform: "freebsd" });

  assert.throws(resolve, /automatic installation is unsupported on freebsd/);
});

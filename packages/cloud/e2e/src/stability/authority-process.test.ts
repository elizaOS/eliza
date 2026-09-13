/** Exercises readiness failures against real child processes that keep running after malformed output. */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopAuthority, waitForAuthorityReady } from "./authority-process.ts";

for (const record of ["not-json", JSON.stringify({ type: "ready", url: 42 })]) {
  test(`invalid readiness stops its owned child before rejecting: ${record}`, async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(`${record}\n`)}); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    );
    try {
      await expect(waitForAuthorityReady(child)).rejects.toThrow();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
}

test("valid readiness transfers a live loopback authority and teardown closes it", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("authority-ready")}); process.stdout.write(JSON.stringify({type:"ready",url:"http://127.0.0.1:"+server.port})+"\\n");`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
  );
  try {
    const url = await waitForAuthorityReady(child);
    expect(await (await fetch(url)).text()).toBe("authority-ready");
    await stopAuthority(child);
    await expect(
      fetch(url, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  } finally {
    await stopAuthority(child);
  }
});

test("silent startup deadline closes the owned process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  try {
    await expect(waitForAuthorityReady(child, 100)).rejects.toThrow("deadline");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    await stopAuthority(child);
  }
});

test("spawn failure rejects without leaving a readiness timer", async () => {
  const child = spawn("/definitely-absent-authority-binary", [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await expect(waitForAuthorityReady(child)).rejects.toThrow("could not start");
  expect(child.pid).toBeUndefined();
});

// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as spec from "../gen/os__signIn__readiness.ts";
import { compileAdapter } from "./drivers/jvm-adapter.ts";

interface Case { readonly fn: string; readonly args: readonly unknown[]; readonly result: unknown }

const javaTool = (name: string) => process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/${name}` : name;

function javaCases(): Case[] {
  const main = "ai.eliza.plugins.signin.ReadinessLawCheck";
  const out = execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case);
}

describe("Show only the methods the cloud is ready for", () => {
  it("answers as the generated spec does over every value the spec names", () => {
    const cases = javaCases();
    const functions = spec as unknown as Record<string, (...args: unknown[]) => unknown>;
    const names = new Set(cases.map((c) => c.fn));
    expect(cases.length).toBeGreaterThan(1000);
    expect([...names].filter((name) => typeof functions[name] !== "function")).toEqual([]);
    const differing = cases.filter((c) => JSON.stringify(functions[c.fn]!(...c.args)) !== JSON.stringify(c.result));
    expect(differing.slice(0, 5)).toEqual([]);
    for (const law of [...names].filter((name) => name.startsWith("law"))) {
      expect(cases.filter((c) => c.fn === law && c.result !== true)).toEqual([]);
    }
  });
});

describe("Read the service's own terms", () => {
  it("is shown only for a registered environment and a well-formed 200 answer", () => {
    expect(spec.serviceOutcome(true, 200, true)).toBe("ServiceShown");
    expect(spec.serviceOutcome(true, 200, false)).toBe("ServiceUnavailable");
    expect(spec.serviceOutcome(false, 200, true)).toBe("ServiceUnknownEnvironment");
  });
});

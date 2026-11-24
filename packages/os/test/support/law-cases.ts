// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"
import { expect } from "vitest";

export interface Case { readonly fn: string; readonly args: readonly unknown[]; readonly result: unknown }

export const javaTool = (name: string) => process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/${name}` : name;

export function expectCasesAgree(cases: readonly Case[], expected: (c: Case) => unknown): void {
  const differing = cases.filter((c) => JSON.stringify(expected(c)) !== JSON.stringify(c.result));
  expect(differing.slice(0, 5)).toEqual([]);
  for (const law of [...new Set(cases.map((c) => c.fn))].filter((name) => name.startsWith("law"))) {
    expect(cases.filter((c) => c.fn === law && c.result !== true)).toEqual([]);
  }
}

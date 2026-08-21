/** Unit tests for unboundedRootFindTarget — the fail-fast guard that rejects
 *  a find over a root-scale directory with no -maxdepth (guaranteed exec
 *  timeout on a dev box). Deterministic, no runtime. */
import { describe, expect, it } from "vitest";
import { unboundedRootFindTarget } from "./bash.js";

describe("unboundedRootFindTarget", () => {
  it("rejects find over $HOME literally", () => {
    expect(unboundedRootFindTarget("find $HOME -name 'x.py'")).toBe("$HOME");
  });

  it("rejects find over the expanded home directory", () => {
    const home = process.env.HOME?.replace(/\/+$/, "") ?? "/home/user";
    expect(unboundedRootFindTarget(`find ${home} -name x.py`)).toBe(home);
  });

  it("rejects find over / and /home", () => {
    expect(unboundedRootFindTarget("find / -name x")).toBe("/");
    expect(unboundedRootFindTarget("find /home -type f")).toBe("/home");
  });

  it("rejects the ls-fallback compound form", () => {
    const home = process.env.HOME?.replace(/\/+$/, "") ?? "/home/user";
    expect(
      unboundedRootFindTarget(
        `ls -R /tmp/guess 2>/dev/null || find ${home} -name script.py`,
      ),
    ).toBe(home);
  });

  it("allows find bounded by -maxdepth", () => {
    expect(
      unboundedRootFindTarget("find $HOME -maxdepth 3 -name x.py"),
    ).toBeUndefined();
  });

  it("allows find over a specific project directory", () => {
    expect(
      unboundedRootFindTarget("find /home/milady/projects/app -name '*.py'"),
    ).toBeUndefined();
  });

  it("ignores commands without find", () => {
    expect(unboundedRootFindTarget("ls -la && python3 x.py")).toBeUndefined();
  });
});

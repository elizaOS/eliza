import { expect, it } from "vitest";
import {
  assertValidScriptPath,
  buildElevatedPowerShellCommand,
  buildWindowsWriteCommand,
  parsePowerShellBoolean,
} from "../windows-backend";

it("keeps spaced paths in one elevated argument and propagates the child status", () => {
  const script = buildWindowsWriteCommand(
    "diskpart.exe",
    ["/s", String.raw`C:\Users\A B\elizaos-diskpart.txt`],
    false,
  );
  expect(script).toContain(
    String.raw`-ArgumentList '"/s" "C:\Users\A B\elizaos-diskpart.txt"'`,
  );
  expect(script).toContain("-Verb RunAs -Wait -PassThru");
  expect(script).toContain(
    'if ($null -eq $child.ExitCode) { throw "Elevated writer returned no exit code." }',
  );
  expect(script).toContain(
    "if ($child.ExitCode -ne 0) { exit $child.ExitCode }",
  );
});

it("quotes Windows backslashes, double quotes, and PowerShell apostrophes at their own boundaries", () => {
  const script = buildWindowsWriteCommand(
    "dd.exe",
    ['a"b', "C:\\trailing\\", "O'Brien"],
    false,
  );
  expect(script).toContain(
    String.raw`-ArgumentList '"a\"b" "C:\trailing\\" "O''Brien"'`,
  );
  for (const value of ["x\0y", "x\ny", "x\ry"])
    expect(() => buildWindowsWriteCommand("dd.exe", [value], false)).toThrow(
      /Invalid Windows/,
    );
});

it("propagates directly invoked native executable failures", () => {
  const script = buildWindowsWriteCommand(
    "dd.exe",
    ["if=C:\\A B\\image.iso"],
    true,
  );
  expect(script).toContain("& 'dd.exe' 'if=C:\\A B\\image.iso'");
  expect(script).toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
  expect(script).not.toContain("Start-Process");
});

it("accepts diskpart scripts only within the exact operation directory", () => {
  const directory = String.raw`C:\Temp\operation`;
  for (const name of ["elizaos-diskpart.txt"])
    expect(() =>
      assertValidScriptPath(`${directory}\\${name}`, directory),
    ).not.toThrow();
  for (const candidate of [
    String.raw`C:\Temp\operation-evil\elizaos-diskpart.txt`,
    String.raw`C:\Temp\operation\..\elizaos-diskpart.txt`,
    String.raw`C:\Temp\operation\subdir\elizaos-diskpart.txt`,
    String.raw`C:\Temp\operation\elizaos-write.cmd`,
  ])
    expect(() => assertValidScriptPath(candidate, directory)).toThrow();
});

it("passes the complete Unicode writer as UTF-16LE instead of a temporary script file", () => {
  const body = "Write-Output '家\nO''Brien'";
  const command = buildElevatedPowerShellCommand(body);
  const encoded = /"-EncodedCommand" "([A-Za-z0-9+/=]+)"/.exec(command)?.[1];
  if (!encoded) throw new Error("Missing encoded PowerShell command.");
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  expect(decoded).toContain(body);
  expect(decoded).toContain('$ErrorActionPreference = "Stop"');
  expect(decoded).toContain("exit 1");
  expect(command).not.toContain("-ExecutionPolicy");
  expect(command).not.toContain(".ps1");
});

it("does not treat failed or malformed capability probes as false", () => {
  expect(parsePowerShellBoolean("yes\r\n")).toBe(true);
  expect(parsePowerShellBoolean("no\r\n")).toBe(false);
  for (const output of ["", "failure", "yes\nno", "WARNING: unavailable\nno"]) {
    expect(() => parsePowerShellBoolean(output)).toThrow(/invalid response/);
  }
});

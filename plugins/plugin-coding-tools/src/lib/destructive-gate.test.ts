/**
 * Destructive-bulk classifier tests: what fires the chat-path confirm gate and
 * — just as load-bearing — what must NOT fire it. Deterministic, no processes.
 */
import { describe, expect, it } from "vitest";
import { classifyDestructiveCommand } from "./destructive-gate";

describe("classifyDestructiveCommand — fires", () => {
  it("rm -rf on a path", () => {
    const v = classifyDestructiveCommand("rm -rf /home/milady/projects/old");
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("recursive delete");
    expect(v.targets).toContain("/home/milady/projects/old");
  });
  it("rm -fr and rm -R variants", () => {
    expect(classifyDestructiveCommand("rm -fr build").destructive).toBe(true);
    expect(classifyDestructiveCommand("rm -R cache").destructive).toBe(true);
  });
  it("GNU long-form --recursive/--force fire like their short flags", () => {
    const recursive = classifyDestructiveCommand("rm --recursive build");
    expect(recursive.destructive).toBe(true);
    expect(recursive.reason).toBe("recursive delete");
    expect(recursive.targets).toContain("build");

    const mixed = classifyDestructiveCommand("rm -R --force cache");
    expect(mixed.destructive).toBe(true);
    expect(mixed.reason).toBe("recursive delete");
    expect(mixed.targets).toContain("cache");

    const both = classifyDestructiveCommand("rm --recursive --force ./data");
    expect(both.destructive).toBe(true);
    expect(both.reason).toBe("recursive delete");
    expect(both.targets).toContain("./data");
  });
  it("forced glob delete via long-form --force", () => {
    const v = classifyDestructiveCommand("rm --force /var/log/*.log");
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("forced glob delete");
    expect(v.targets).toContain("/var/log/*.log");
  });
  it("recognizes GNU's unambiguous long-option abbreviations", () => {
    expect(classifyDestructiveCommand("rm --rec build")).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["build"],
    });
    expect(classifyDestructiveCommand("rm --f *.log")).toMatchObject({
      destructive: true,
      reason: "forced glob delete",
      targets: ["*.log"],
    });
  });
  it("reports a dash-prefixed target after the option terminator", () => {
    expect(
      classifyDestructiveCommand("rm --recursive -- -old-cache"),
    ).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["-old-cache"],
    });
  });
  it.each([
    ["Remove-Item -LiteralPath C:\\temp\\old -Recurse -Force"],
    ["remove-item C:\\temp\\old -Rec -Force"],
    ["ri -R C:\\temp\\old"],
    ["rmdir -Recurse C:\\temp\\old"],
  ])("PowerShell recursive delete: %s", (command) => {
    const verdict = classifyDestructiveCommand(command);
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toBe("recursive delete");
    expect(verdict.targets).toContain("C:\\temp\\old");
  });
  it("recursive rm hidden behind a chain", () => {
    const v = classifyDestructiveCommand("ls && rm -rf ./data");
    expect(v.destructive).toBe(true);
  });
  it.each([
    ["line feed", "printf safe\nrm -rf ./data"],
    ["carriage return", "printf safe\rrm -rf ./data"],
    ["background separator", "printf safe & rm -rf ./data"],
  ])("recursive rm hidden behind an unquoted %s", (_name, command) => {
    expect(classifyDestructiveCommand(command)).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./data"],
    });
  });
  it("forced glob delete", () => {
    expect(
      classifyDestructiveCommand("rm -f /var/log/app/*.log").destructive,
    ).toBe(true);
  });
  it("find -delete", () => {
    expect(
      classifyDestructiveCommand("find /tmp/scratch -name '*.tmp' -delete")
        .destructive,
    ).toBe(true);
  });
  it("dd onto a raw device", () => {
    const v = classifyDestructiveCommand("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(v.destructive).toBe(true);
    expect(v.targets).toContain("of=/dev/sda");
  });
  it("mkfs family and shred", () => {
    expect(classifyDestructiveCommand("mkfs.ext4 /dev/sdb1").destructive).toBe(
      true,
    );
    expect(classifyDestructiveCommand("shred -u secrets.txt").destructive).toBe(
      true,
    );
  });
  it("DROP DATABASE through a sql runner", () => {
    const v = classifyDestructiveCommand('psql -c "DROP DATABASE eliza"');
    expect(v.destructive).toBe(true);
    expect(v.targets[0]).toContain("eliza");
  });
});

describe("classifyDestructiveCommand — must NOT fire", () => {
  it.each([
    ["ls -la /tmp"],
    ["rm single-file.txt"],
    ["rm -f one-exact-file.log"],
    ["rm --force one-exact-file.log"],
    ["rm -- --recursive"],
    ["rm -- --force"],
    ["git rm --recursive old-module"],
    ["Remove-Item one-exact-file.log"],
    ["git rm old.ts"],
    ["df -h / && du -sh /home"],
    ["grep -r pattern src/"],
    ["echo 'rm -rf /' # just talking about it"],
    ["find . -name '*.ts' -print"],
    ["dd if=/dev/urandom of=./random.bin count=1"],
    ["mkdir -p new/dir"],
  ])("%s", (command) => {
    expect(classifyDestructiveCommand(command).destructive).toBe(false);
  });
  it("quoted rm -rf inside a string argument does not fire", () => {
    expect(
      classifyDestructiveCommand('echo "rm -rf would be bad"').destructive,
    ).toBe(false);
  });
  it.each([
    ["line feed", "printf 'safe\nrm -rf ./data'"],
    ["carriage return", "printf 'safe\rrm -rf ./data'"],
    ["ampersand", "printf 'safe & rm -rf ./data'"],
    ["escaped ampersand", "printf safe \\& rm -rf ./data"],
    ["escaped line feed", "printf safe \\\nrm -rf ./data"],
    ["file-descriptor redirect", "echo ok 2>&1"],
    ["combined output redirect", "printf ok &> ./out"],
    ["CRLF quoted content", "printf 'safe\r\nrm -rf ./data'"],
    ["escaped double quote", String.raw`printf "safe \"rm -rf ./data\""`],
  ])("%s remains one benign segment", (_name, command) => {
    expect(classifyDestructiveCommand(command).destructive).toBe(false);
  });

  it.each([
    ["unquoted", "cat <<EOF\nrm -rf ./data\nEOF"],
    ["single-quoted", "cat <<'EOF'\nrm -rf ./data\nEOF"],
    ["double-quoted", 'cat <<"EOF"\nDROP DATABASE production\nEOF'],
    ["concatenated quoted word", "cat <<'E'OF\nrm -rf ./data\nEOF"],
    ["tab-stripped", "cat <<-EOF\n\trm -rf ./data\n\tEOF"],
  ])(
    "%s heredoc payload is data, not an executable segment",
    (_name, command) => {
      expect(classifyDestructiveCommand(command).destructive).toBe(false);
    },
  );

  it("resumes classification after a heredoc terminator", () => {
    expect(
      classifyDestructiveCommand(
        "cat <<EOF\nrm -rf ./data\nEOF\nrm -rf ./cache",
      ),
    ).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./cache"],
    });
  });

  it.each([
    ["expansion", "echo $((1 << 2))\nrm -rf ./data"],
    ["command", "(( flags << 1 ))\nrm -rf ./data"],
    ["legacy expansion", "echo $[1<<2]\nrm -rf ./data\n2]"],
    ["indexed assignment", "slots[1<<2]=ready\nrm -rf ./data\n2]=ready"],
  ])("does not mistake an arithmetic %s for a heredoc", (_name, command) => {
    expect(classifyDestructiveCommand(command)).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./data"],
    });
  });

  it("resumes after an unquoted heredoc terminator uses line continuation", () => {
    expect(
      classifyDestructiveCommand(
        "cat <<EOF\nsafe payload\nEO\\\nF\nrm -rf ./data\nEOF",
      ),
    ).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./data"],
    });
  });

  it.each([
    ["simple", `echo \${value:-<<EOF}\nrm -rf ./data\nEOF`],
    ["nested", `echo \${value:-\${fallback:-<<EOF}}\nrm -rf ./data\nEOF`],
    ["continued delimiter", "cat <<EO\\\nF\npayload\nEOF\nrm -rf ./data"],
    ["continued declaration", "cat <<EOF \\\n; rm -rf ./data\npayload\nEOF"],
  ])("does not let a %s hide a later executable segment", (_name, command) => {
    expect(classifyDestructiveCommand(command)).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./data"],
    });
  });

  it.each([
    ["semicolon", "echo hi;# cat <<EOF\nrm -rf ./data\nEOF"],
    ["background operator", "echo hi &# cat <<EOF\nrm -rf ./data\nEOF"],
  ])("ignores a fake heredoc in a comment after a %s", (_name, command) => {
    expect(classifyDestructiveCommand(command)).toMatchObject({
      destructive: true,
      reason: "recursive delete",
      targets: ["./data"],
    });
  });

  it("does not fold a quoted heredoc body's continued physical lines", () => {
    expect(
      classifyDestructiveCommand("cat <<'EOF'\nEO\\\nF\nrm -rf ./data\nEOF")
        .destructive,
    ).toBe(false);
  });
});

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
    const verdict = classifyDestructiveCommand(command, "powershell");
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

describe("classifyDestructiveCommand — lexical bypass resistance", () => {
  it.each([
    ["'r''m' -rf ./quoted", "posix"],
    ["r\\m -rf ./escaped", "posix"],
    ["m\\\nkfs.ext4 /dev/sdz1", "posix"],
    [
      "printf safe # '\" comment cannot poison quote state\nmkfs.ext4 /dev/sdz1",
      "posix",
    ],
    ["(printf ready; rm -rf ./grouped)", "posix"],
    ["printf '%s' \"$(rm -rf ./substitution)\"", "posix"],
    ["printf '%s' \"$(printf ')'; rm -rf ./quoted-paren)\"", "posix"],
    ["printf '%s' `rm -rf ./legacy-substitution`", "posix"],
    ["sh -c 'rm -rf ./nested-shell'", "posix"],
    ["bash -lc 'rm -rf ./login-shell'", "posix"],
    ["zsh -fc 'rm -rf ./fast-shell'", "posix"],
    ["sh -xc 'rm -rf ./traced-shell'", "posix"],
    ["env -u UNUSED bash -lc 'rm -rf ./wrapped-shell'", "posix"],
    ["exec rm -rf ./exec-wrapped", "posix"],
    ["timeout --signal TERM 10 rm -rf ./timeout-wrapped", "posix"],
    ["setsid rm -rf ./setsid-wrapped", "posix"],
    ["stdbuf -o L rm -rf ./stdbuf-wrapped", "posix"],
    ["chroot /srv/root rm -rf ./chroot-wrapped", "posix"],
    ["chrt -f 50 rm -rf ./chrt-wrapped", "posix"],
    ["ionice -c 2 rm -rf ./ionice-wrapped", "posix"],
    ["unshare --mount rm -rf ./unshare-wrapped", "posix"],
    ["runuser -u root -- rm -rf ./runuser-wrapped", "posix"],
    ["su -c 'rm -rf ./su-wrapped' root", "posix"],
    ["watch -n 2 rm -rf ./watch-wrapped", "posix"],
    ["script -q -c 'rm -rf ./script-wrapped' /dev/null", "posix"],
    ["noglob rm -rf ./noglob-wrapped", "posix"],
    ["repeat 2 rm -rf ./repeat-wrapped", "posix"],
    ["flock /tmp/eliza.lock rm -rf ./flock-wrapped", "posix"],
    ["taskset ff rm -rf ./taskset-wrapped", "posix"],
    ["! rm -rf ./negated", "posix"],
    ["if rm -rf ./if-condition; then :; fi", "posix"],
    ["printf ready; then rm -rf ./then-body", "posix"],
    ["env -S 'rm -rf ./split-string'", "posix"],
    ["env -S'rm -rf ./attached-split-string'", "posix"],
    ["env -S 'rm\\_-rf\\_./escaped-split-string'", "posix"],
    ["$'rm' -rf ./ansi-quoted", "posix"],
    ["/bin/r? -rf ./globbed-executable", "posix"],
    ["@(rm) -rf ./extglobbed-executable", "posix"],
    ["rm -{r,r}f ./brace-expanded", "posix"],
    ["printf 'rm -rf ./piped-shell' | bash", "posix"],
    ["bash <<EOF\nprintf safe\nEOF", "posix"],
    ["bash <<< 'printf safe'", "posix"],
    ["cat <<EOF\n$(rm -rf ./heredoc-substitution)\nEOF", "posix"],
    ["cat ./migration.sql | psql", "posix"],
    ["psql --file ./migration.sql", "posix"],
    ["alias cleanup='rm -rf'; cleanup ./aliased", "posix"],
    ["trap 'rm -rf ./trapped' EXIT", "posix"],
    ["hash -p /bin/rm cleanup", "posix"],
    ["Set-Alias cleanup Remove-Item", "powershell"],
    ["Start-Process rm -ArgumentList '-rf ./started-native'", "powershell"],
    ["saps -FilePath rm -ArgumentList '-rf ./started-alias'", "powershell"],
    [
      "start pwsh -ArgumentList \"-Command 'Remove-Item C:\\temp\\started -Recurse'\"",
      "powershell",
    ],
    ["busybox rm -rf ./busybox-wrapped", "posix"],
    ["rm --recurs ./gnu-long-option", "posix"],
    ["Remove-Item C:\\temp\\* -Force", "powershell"],
    ["bash --rcfile /dev/null -lc 'rm -rf ./rcfile-shell'", "posix"],
    ["eval 'rm -rf ./evaluated'", "posix"],
    ["printf 'DROP DATABASE eliza' | cat | psql", "posix"],
    ["find ./cache -type f -exec rm -rf {} +", "posix"],
    ["env -u UNUSED sudo -u root rm -rf ./wrapped", "posix"],
    ["printf '%s\\n' ./cache | xargs -n 1 rm -rf", "posix"],
    ["Remove-`Item C:\\temp\\old -Recurse", "powershell"],
    ["Remove-`\nItem C:\\temp\\old -Recurse", "powershell"],
    ["Remove-`\r\nItem C:\\temp\\old -Recurse", "powershell"],
    [
      "Write-Output safe # '\" cannot poison state\nRemove-Item C:\\temp\\old -Recurse",
      "powershell",
    ],
    ["& 'Remove-Item' -LiteralPath C:\\temp\\old -Recurse", "powershell"],
    ["& { Remove-Item C:\\temp\\old -Recurse }", "powershell"],
    ["pwsh -Command 'Remove-Item C:\\temp\\old -Recurse'", "powershell"],
    ["pwsh -Command Remove-Item C:\\temp\\old -Recurse", "powershell"],
    ["pwsh -Com 'Remove-Item C:\\temp\\old -Recurse'", "powershell"],
    ["rm -Recurse:$true C:\\temp\\old", "powershell"],
    ["Invoke-Expression 'Remove-Item C:\\temp\\old -Recurse'", "powershell"],
    ["Write-Output $((Remove-Item C:\\temp\\old -Recurse))", "powershell"],
    ["find /bin -name rm -exec {} -rf ./placeholder-target \\;", "posix"],
    ["printf /bin/rm | xargs -I CMD env CMD -rf ./placeholder-target", "posix"],
    ["env --argv0 fake rm -rf ./shifted-env", "posix"],
    ["sudo -T 10 rm -rf ./shifted-sudo", "posix"],
    ["unshare --setuid 0 rm -rf ./shifted-unshare", "posix"],
    ["runuser -u root -w FOO rm -rf ./shifted-runuser", "posix"],
    ["flock --start 0 /tmp/lock rm -rf ./shifted-flock", "posix"],
    ["bash ./cleanup.sh", "posix"],
    [". /dev/stdin <<'EOF'\nrm -rf ./sourced\nEOF", "posix"],
    ["source <(printf 'rm -rf ./sourced')", "posix"],
    ["Start-Process rm -ArgumentList:'-rf ./attached'", "powershell"],
    ["Start-Process rm -Args:'-rf ./abbreviated'", "powershell"],
    ["Start-Process rm -ArgumentList [string]'-rf ./typed'", "powershell"],
    ["Start-Process rm -ArgumentList @'\n-rf ./here-string\n'@", "powershell"],
  ] as const)("%s (%s)", (command, dialect) => {
    expect(classifyDestructiveCommand(command, dialect).destructive).toBe(true);
  });

  it.each([
    ["$command -rf ./unknown", "posix"],
    ['sh -c "$program"', "posix"],
    ['eval "$program"', "posix"],
    ["& $command -Recurse C:\\temp\\old", "powershell"],
    ["Invoke-Expression $program", "powershell"],
    ["& ('Remove-' + 'Item') C:\\temp\\old -Recurse", "powershell"],
    ["pwsh -EncodedCommand UgBlAG0AbwB2AGUALQBJAHQAZQBtAA==", "powershell"],
    ["pwsh -Command -", "powershell"],
    ["pwsh -File ./cleanup.ps1", "powershell"],
    ["opts=-rf; rm $opts ./dynamic-options", "posix"],
    ["opts=-rf; rm $" + "{opts} ./dynamic-braced-options", "posix"],
    ["rm -f $pattern", "posix"],
    ["timeout $options 10 rm -rf ./dynamic-timeout", "posix"],
    ["dd if=/dev/zero of=$device", "posix"],
    ["find ./cache $expression", "posix"],
    ["psql -c $query", "posix"],
    ["Remove-Item @removeArgs", "powershell"],
    ["Start-Process $tool -ArgumentList '-rf ./dynamic-tool'", "powershell"],
    ["Start-Process rm -ArgumentList $arguments", "powershell"],
    ["Start-Process rm -ArgumentList '-rf','./opaque-array'", "powershell"],
    ["printf 'unterminated", "posix"],
    ["Write-Output 'unterminated", "powershell"],
  ] as const)(
    "fails to confirmation for unprovable syntax: %s",
    (command, dialect) => {
      const verdict = classifyDestructiveCommand(command, dialect);
      expect(verdict.destructive).toBe(true);
      expect(verdict.reason).toContain("requires confirmation");
    },
  );
});

describe("classifyDestructiveCommand — dialect-safe controls", () => {
  it.each([
    ["printf '%s\\n' 'rm -rf ./mentioned'", "posix"],
    ["printf '%s\\n' '$(rm -rf ./not-executed)'", "posix"],
    ["printf '%s\\n' \"r\\m -rf ./still-text\"", "posix"],
    ["printf '%s\\n' \"$(printf ')')\"", "posix"],
    ["printf safe # rm -rf ./commented", "posix"],
    ["printf safe # '\"\nprintf done", "posix"],
    ["sh -c 'printf safe'", "posix"],
    ["bash -lc 'printf safe'", "posix"],
    ["sh -xc 'printf safe'", "posix"],
    ["bash -o noclobber -lc 'printf safe'", "posix"],
    ["bash --rcfile /dev/null -lc 'printf safe'", "posix"],
    ["if printf safe; then :; fi", "posix"],
    ['do [ -e "$path" ]', "posix"],
    ["env -S 'printf safe'", "posix"],
    ["env -S'printf safe'", "posix"],
    ["chrt -f 50 printf '%s' rm -rf", "posix"],
    ["ionice -c 2 printf '%s' rm -rf", "posix"],
    ["unshare --mount printf '%s' rm -rf", "posix"],
    ["runuser -u root -- printf '%s' rm -rf", "posix"],
    ["su -c 'printf safe' root", "posix"],
    ["watch -n 2 printf safe", "posix"],
    ["script -q -c 'printf safe' /dev/null", "posix"],
    ["repeat 2 printf safe", "posix"],
    ["flock /tmp/eliza.lock printf '%s' rm -rf", "posix"],
    ["taskset ff printf '%s' rm -rf", "posix"],
    ["eval 'printf safe'", "posix"],
    ["rm -f ./one-file", "posix"],
    ["rm -f './literal-*'", "posix"],
    ["rm -- $singleFile", "posix"],
    ["printf '%s' $" + "{dynamicValue}", "posix"],
    ["alias p='printf safe'", "posix"],
    ["trap 'printf safe' EXIT", "posix"],
    ["trap -l", "posix"],
    ["cat <<EOF\nrm -rf ./heredoc-documentation\nEOF", "posix"],
    ["cat <<'EOF'\n$(rm -rf ./quoted-heredoc)\nEOF", "posix"],
    ["cat <<-EOF\n\trm -rf ./tabbed-heredoc-documentation\n\tEOF", "posix"],
    ["cat <<< 'rm -rf ./here-string-documentation'", "posix"],
    ["env -u UNUSED printf safe", "posix"],
    ["sudo -u root printf safe", "posix"],
    ["printf safe | xargs -n 1 printf '%s\\n'", "posix"],
    ["printf '%s\\n' 'DROP DATABASE documentation'", "posix"],
    ["Write-Output 'Remove-Item C:\\temp\\old -Recurse'", "powershell"],
    ["Write-Output '# Remove-Item C:\\temp\\old -Recurse'", "powershell"],
    ["Write-Output '<# Remove-Item C:\\temp\\old -Recurse #>'", "powershell"],
    ["Write-Output 'Remove-`Item C:\\temp\\old -Recurse'", "powershell"],
    ["pwsh -Command 'Write-Output safe'", "powershell"],
    ["Remove-Item C:\\temp\\one.txt", "powershell"],
    ["Remove-Item $singleFile", "powershell"],
    ["Start-Process printf -ArgumentList safe", "powershell"],
    ["start -FilePath printf -ArgumentList safe", "powershell"],
    ["Start-Process printf -Wait", "powershell"],
  ] as const)("%s (%s)", (command, dialect) => {
    expect(classifyDestructiveCommand(command, dialect).destructive).toBe(
      false,
    );
  });
});

describe("classifyDestructiveCommand — bounded failure policy", () => {
  it("requires confirmation when the source limit is exceeded", () => {
    const verdict = classifyDestructiveCommand(`printf ${"x".repeat(65_536)}`);
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toContain("source length limit exceeded");
  });

  it("requires confirmation when the token limit is exceeded", () => {
    const verdict = classifyDestructiveCommand(
      Array.from({ length: 4_097 }, () => "x").join(" "),
    );
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toContain("token limit exceeded");
  });

  it("requires confirmation when nested substitutions exceed the depth limit", () => {
    const verdict = classifyDestructiveCommand(
      `${"$(".repeat(14)}printf safe${")".repeat(14)}`,
    );
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toContain("nesting limit exceeded");
  });

  it("requires confirmation when wrapper nesting exceeds the depth limit", () => {
    const verdict = classifyDestructiveCommand(
      `${"env ".repeat(14)}printf safe`,
    );
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toContain("nesting limit exceeded");
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
    ["empty quoted delimiter", "cat <<''\nrm -rf ./data\n\n"],
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

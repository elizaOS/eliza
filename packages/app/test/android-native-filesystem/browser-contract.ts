/** Real service calls through the installed Android Capacitor Filesystem bridge. */
import { Directory, Filesystem } from "@capacitor/filesystem";
import { DeviceFilesystemBridge } from "../../../../plugins/plugin-native-filesystem/src/services/device-filesystem-bridge";

(async () => {
  const host = window as unknown as {
    filesystemPhase: string;
    filesystemRoot: string;
    filesystemProof: unknown;
    Capacitor: {
      getPlatform(): string;
      isNativePlatform(): boolean;
      isPluginAvailable(name: string): boolean;
    };
  };
  let assertions = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    assertions++;
  };
  try {
    check(
      host.Capacitor.getPlatform() === "android" &&
        host.Capacitor.isNativePlatform(),
      "Android native platform required",
    );
    check(
      host.Capacitor.isPluginAvailable("Filesystem"),
      "Real Filesystem bridge must be registered",
    );
    const { filesystemRoot: root, filesystemPhase: phase } = host;
    check(
      /^eliza-capacitor-e2e-[a-f0-9-]+$/.test(root),
      "Isolated fixture root required",
    );
    check(phase === "write" || phase === "reopen", "Known phase required");
    // The service does not require a runtime for its Capacitor backend; its
    // real Service base accepts an absent runtime in this isolated host.
    const service = await DeviceFilesystemBridge.start(undefined as never);
    const text = "Capacitor café 漢字 👋\nNUL:\0\n".repeat(2048);
    const bytes = Array.from({ length: 4096 }, (_, i) => i % 256);
    const binary = btoa(String.fromCharCode(...bytes));
    if (phase === "write") {
      await service.write(`${root}/nested//./文字.txt`, text);
      await service.write(`${root}/nested/binary.bin`, binary, "base64");
      await service.write(`${root}/overwrite.txt`, "a longer original value");
      await service.write(`${root}/overwrite.txt`, "short");
    }
    const actualText = await service.read(`${root}/nested/文字.txt`);
    const actualBinary = await service.read(
      `${root}/nested/binary.bin`,
      "base64",
    );
    check(
      actualText === text,
      "Complete Unicode/NUL content must survive WebView recreation",
    );
    check(actualBinary === binary, "All binary bytes must round trip");
    check(
      (await service.read(`${root}/overwrite.txt`)) === "short",
      "Overwrite must truncate",
    );
    const entries = await service.list(`${root}/nested`);
    check(
      entries.length === 2 &&
        entries.every((entry) => entry.type === "file") &&
        entries.some((entry) => entry.name === "文字.txt") &&
        entries.some((entry) => entry.name === "binary.bin"),
      "Real native directory listing",
    );
    const rejected: unknown[] = [];
    for (const method of ["read", "write", "list"] as const) {
      for (const invalid of [
        "../escape",
        "/absolute",
        "C:\\absolute",
        `${root}/../escape`,
        "nul\0byte",
      ]) {
        let failure: string | undefined;
        try {
          if (method === "write") await service.write(invalid, "invalid");
          else await service[method](invalid);
        } catch (error) {
          failure = String(error);
        }
        check(failure, `${method} must reject ${JSON.stringify(invalid)}`);
        rejected.push({ method, path: invalid, error: failure });
      }
    }
    let missing: unknown;
    try {
      await service.read(`${root}/missing.txt`);
    } catch (error) {
      missing = String(error);
    }
    check(missing, "Missing native file must reject");
    await service.stop();
    if (phase === "reopen")
      await Filesystem.rmdir({
        path: root,
        directory: Directory.Documents,
        recursive: true,
      });
    host.filesystemProof = {
      pass: true,
      phase,
      assertions,
      text: actualText,
      binaryBase64: actualBinary,
      entries,
      rejected,
      missing,
    };
  } catch (error) {
    host.filesystemProof = { pass: false, error: String(error), assertions };
  }
})();

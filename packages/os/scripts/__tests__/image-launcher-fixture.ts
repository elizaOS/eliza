/**
 * Fabricated Android SDK tools and an Eliza launcher manifest for staging
 * tests. Nothing here builds, signs or boots an image.
 */
import fs from "node:fs";
import path from "node:path";

export const PKG = "ai.elizaos.app";
export const SIGNER = "c".repeat(64);
const str = (value: string) => `"${value}" (Raw: "${value}")`;
const element = (indent: number, tag: string, attrs = {}) => [
  `${" ".repeat(indent)}E: ${tag} (line=1)`,
  ...Object.entries(attrs).map(
    ([key, value]) =>
      `${" ".repeat(indent + 2)}A: android:${key}(0x01010003)=${String(value).startsWith("(") ? value : str(String(value))}`,
  ),
];
const filter = (indent: number, action: string, categories: string[] = []) => [
  ...element(indent, "intent-filter"),
  ...element(indent + 2, "action", { name: action }),
  ...categories.flatMap((name) => element(indent + 2, "category", { name })),
];
const exported = "(type 0x12)0xffffffff";

export const manifestTree = [
  "N: android=http://schemas.android.com/apk/res/android",
  "  E: manifest (line=2)",
  "    E: application (line=3)",
  ...element(6, "activity", { name: `${PKG}.MainActivity`, exported }),
  ...filter(8, "android.intent.action.MAIN", [
    "android.intent.category.HOME",
    "android.intent.category.DEFAULT",
  ]),
  ...element(6, "activity", { name: `${PKG}.ElizaAssistActivity`, exported }),
  ...filter(8, "android.intent.action.ASSIST", [
    "android.intent.category.DEFAULT",
  ]),
].join("\n");

export const badging = [
  `package: name='${PKG}' versionCode='1'`,
  "uses-permission: name='android.permission.RECORD_AUDIO'",
  "uses-permission: name='android.permission.POST_NOTIFICATIONS'",
  "uses-permission: name='android.permission.MANAGE_APP_OPS_MODES'",
].join("\n");

/** Write fake aapt/apksigner tools and a fixture APK under `root`. */
export function fakeTools(root: string, apkBytes = "fixture launcher APK") {
  fs.mkdirSync(root, { recursive: true });
  const write = (name: string, body: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, {
      mode: 0o700,
    });
    return file;
  };
  const data = path.join(root, "tool-data.json");
  fs.writeFileSync(
    data,
    JSON.stringify({ badging, manifestTree, signer: SIGNER }),
  );
  // CommonJS tools, independent of any enclosing package "type".
  const aapt = write(
    "aapt.cjs",
    `const d=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(data)},'utf8'));const a=process.argv.slice(2);if(a[0]==='dump'&&a[1]==='badging')console.log(d.badging);else if(a[0]==='dump'&&a[1]==='xmltree'&&a[3]==='AndroidManifest.xml')console.log(d.manifestTree);else process.exit(2);`,
  );
  const apksigner = write(
    "apksigner.cjs",
    `const d=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(data)},'utf8'));const a=process.argv.slice(2);if(a[0]!=='verify'||a[1]!=='--print-certs')process.exit(2);console.log('Signer #1 certificate SHA-256 digest: '+d.signer);`,
  );
  const apk = path.join(root, "signed.apk");
  fs.writeFileSync(apk, apkBytes);
  return { aapt, apksigner, apk };
}

export const brandFor = (productName: string) => ({
  brand: "eliza",
  appName: "Eliza",
  distroName: "elizaOS",
  packageName: PKG,
  productName,
  buildAndroidSystemCmd: ["bun", "run", "build:android:system"],
});

/** Pure aapt dump decoding. Host-specific release policy belongs to the caller. */
const COMPONENT_TAGS = new Set([
  "activity",
  "activity-alias",
  "service",
  "receiver",
  "provider",
]);
const TRUE = "0xffffffff";

function rawAttributeValue(encoded) {
  const value = encoded.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (quoted) return quoted[1];
  return /^\(type 0x[0-9a-f]+\)(0x[0-9a-f]+)$/.exec(value)?.[1] ?? value;
}

/** Parse `aapt dump xmltree`; callers may supply their own attribute decoder. */
export function parseXmlTree(
  text,
  { decodeAttribute = rawAttributeValue } = {},
) {
  const root = { name: "#root", attrs: {}, children: [], indent: -1 };
  const stack = [root];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)([EA]): (.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    if (match[2] === "E") {
      const name = /^(\S+)/.exec(match[3])[1];
      while (stack.at(-1).indent >= indent) stack.pop();
      const node = { name, attrs: {}, children: [], indent };
      stack.at(-1).children.push(node);
      stack.push(node);
    } else {
      while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
      // e.g. android:name(0x01010003)="value" (Raw: "value")
      //      android:exported(0x01010010)=(type 0x12)0xffffffff
      //      android:networkSecurityConfig(0x01010527)=@0x7f150002
      const attr =
        /^(?:[^\s(]*:)?([A-Za-z_][\w.-]*)(?:\(0x[0-9a-f]+\))?=(.*)$/i.exec(
          match[3],
        );
      if (!attr) continue;
      stack.at(-1).attrs[attr[1]] = decodeAttribute(attr[2]);
    }
  }
  return root;
}
function* walk(node) {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}
const isTrue = (value) => value === TRUE;

/** Extract the release-relevant facts from aapt manifest and badging dumps. */
export function manifestFacts(xml, badging = "") {
  const tree = parseXmlTree(xml);
  const elements = [...walk(tree)];
  const manifest = elements.find((node) => node.name === "manifest");
  const application = elements.find((node) => node.name === "application");
  const packageName =
    manifest?.attrs.package ?? /package: name='([^']+)'/.exec(badging)?.[1];
  const permissions = elements
    .filter(
      (node) =>
        node.name === "uses-permission" ||
        node.name === "uses-permission-sdk-23",
    )
    .map((node) => node.attrs.name)
    .filter(Boolean);
  const qualify = (name) =>
    name?.startsWith(".")
      ? packageName + name
      : name?.includes(".")
        ? name
        : `${packageName}.${name}`;
  const components = elements
    .filter((node) => COMPONENT_TAGS.has(node.name))
    .map((node) => ({
      tag: node.name,
      name: qualify(node.attrs.name),
      exported: isTrue(node.attrs.exported),
      permission: node.attrs.permission ?? null,
    }));
  const queriedPackages = elements
    .filter((node) => node.name === "package")
    .map((node) => node.attrs.name)
    .filter(Boolean);
  const versionCodeText =
    /versionCode='([^']*)'/.exec(badging)?.[1] ?? manifest?.attrs.versionCode;
  const versionName =
    /versionName='([^']*)'/.exec(badging)?.[1] ??
    manifest?.attrs.versionName ??
    null;
  return {
    packageName,
    versionCodeText: versionCodeText ?? null,
    versionCode: /^[1-9]\d*$/.test(versionCodeText ?? "")
      ? Number(versionCodeText)
      : null,
    versionName,
    permissions,
    components,
    exported: components.filter((component) => component.exported),
    queriedPackages,
    application: {
      allowBackup: application?.attrs.allowBackup ?? null,
      usesCleartextTraffic: application?.attrs.usesCleartextTraffic ?? null,
      networkSecurityConfig: application?.attrs.networkSecurityConfig ?? null,
      debuggable: application?.attrs.debuggable ?? null,
    },
  };
}

/**
 * Production provisioning overlay for an AOSP product that ships the launcher:
 * default HOME (a preferred-activity entry read on first boot), the default
 * assistant role holder and the default Autofill service offer, as an additive
 * resource overlay and copied file next to the staged launcher module.
 *
 * Each value is derived from, and checked against, the admitted APK's manifest:
 * MAIN/HOME/DEFAULT activity, ACTION_ASSIST activity, and the exported
 * BIND_AUTOFILL_SERVICE-protected AutofillService. This is staging output only;
 * the defaults are proven only by booting the built image (separate gate).
 */
import fs from "node:fs";
import path from "node:path";

const component = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_$]*)+$/;
const xml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Parse the activities, activity-aliases and services of an `aapt dump xmltree`
 * manifest with their attributes and intent filters. Shared by the staging checks.
 */
export function manifestComponents(xmltree) {
  const lines = xmltree.split("\n");
  const elements = [];
  for (let index = 0; index < lines.length; index++) {
    const match =
      /^(\s*)E: (activity|activity-alias|service|intent-filter|action|category) /.exec(
        lines[index],
      );
    if (!match) continue;
    const depth = match[1].length;
    const attrs = {};
    for (
      let next = index + 1;
      next < lines.length && /^\s*A: /.test(lines[next]);
      next++
    ) {
      const attr =
        /A: (?:android:)?([A-Za-z]+)\([^)]*\)=(?:\(type [^)]*\))?"?([^"\s]*)"?/.exec(
          lines[next],
        );
      if (attr) attrs[attr[1]] = attr[2];
    }
    elements.push({ depth, tag: match[2], attrs });
  }
  const components = [];
  let current = null,
    filter = null;
  for (const element of elements) {
    if (["activity", "activity-alias", "service"].includes(element.tag)) {
      current = {
        tag: element.tag,
        depth: element.depth,
        name: element.attrs.name,
        exported: element.attrs.exported,
        permission: element.attrs.permission,
        attrs: element.attrs,
        filters: [],
      };
      components.push(current);
      filter = null;
    } else if (current && element.depth > current.depth) {
      if (element.tag === "intent-filter") {
        filter = { actions: [], categories: [] };
        current.filters.push(filter);
      } else if (filter && element.tag === "action")
        filter.actions.push(element.attrs.name);
      else if (filter && element.tag === "category")
        filter.categories.push(element.attrs.name);
    } else current = null;
  }
  return components;
}

/** Find the components a provisioning overlay names in an `aapt dump xmltree` manifest. */
export function provisioningComponents(xmltree, packageName) {
  const components = manifestComponents(xmltree);
  const qualify = (name) => (name?.startsWith(".") ? packageName + name : name);
  const has = (row, action, categories = []) =>
    row.filters.some(
      (f) =>
        f.actions.includes(action) &&
        categories.every((c) => f.categories.includes(c)),
    );
  const home = components.filter(
    (row) =>
      row.tag !== "service" &&
      has(row, "android.intent.action.MAIN", [
        "android.intent.category.HOME",
        "android.intent.category.DEFAULT",
      ]),
  );
  const assist = components.filter(
    (row) =>
      row.tag !== "service" &&
      has(row, "android.intent.action.ASSIST", [
        "android.intent.category.DEFAULT",
      ]),
  );
  const autofill = components.filter(
    (row) =>
      row.tag === "service" &&
      has(row, "android.service.autofill.AutofillService"),
  );
  if (
    autofill.some(
      (row) => row.permission !== "android.permission.BIND_AUTOFILL_SERVICE",
    )
  )
    throw new Error("AutofillService requires BIND_AUTOFILL_SERVICE");
  const one = (rows, what) => {
    if (rows.length !== 1)
      throw new Error(
        `The APK must declare exactly one ${what}; found ${rows.length}`,
      );
    if (!["true", "0xffffffff"].includes(rows[0].exported))
      throw new Error(`The ${what} must be explicitly exported`);
    const name = qualify(rows[0].name);
    if (!component.test(name ?? ""))
      throw new Error(`Invalid ${what} component ${name}`);
    return name;
  };
  return {
    home: one(home, "MAIN/HOME/DEFAULT activity"),
    assistant: one(assist, "ACTION_ASSIST activity"),
    autofill: autofill.length
      ? one(autofill, "BIND_AUTOFILL_SERVICE AutofillService")
      : null,
  };
}

export function renderProvisioningOverlay(
  packageName,
  { home, assistant, autofill },
) {
  if (!component.test(packageName))
    throw new Error(`Invalid package ${packageName}`);
  for (const name of [home, assistant, ...(autofill ? [autofill] : [])]) {
    if (!component.test(name ?? ""))
      throw new Error("Invalid fully qualified provisioning component");
  }
  return {
    "provisioning/overlay/frameworks/base/core/res/res/values/config.xml": `<?xml version="1.0" encoding="utf-8"?>
<!-- the launcher production provisioning. Generated by scripts/stage-aosp.mjs --production. -->
<!-- Assistant role holder (package of ${xml(assistant)}) and the default Autofill service offer; users can change both in Settings. -->
<resources>
    <string name="config_defaultAssistant" translatable="false">${xml(packageName)}</string>
${autofill ? `    <string name="config_defaultAutofillService" translatable="false">${xml(packageName)}/${xml(autofill)}</string>` : ""}
</resources>
`,
    "provisioning/preferred-apps/launcher-home.xml": `<?xml version="1.0" encoding="utf-8"?>
<!-- Default HOME on first boot. The stock launcher stays installed as a recovery path. -->
<preferred-activities>
    <item name="${xml(packageName)}/${xml(home)}" match="100000" set="1">
        <set name="${xml(packageName)}/${xml(home)}" />
        <filter>
            <action name="android.intent.action.MAIN" />
            <cat name="android.intent.category.HOME" />
            <cat name="android.intent.category.DEFAULT" />
        </filter>
    </item>
</preferred-activities>
`,
    "provisioning/README.md": `# the launcher provisioning overlay

Generated by \`scripts/stage-aosp.mjs --production\` from the admitted APK manifest.

- Default HOME: \`${packageName}/${home}\` (\`etc/preferred-apps\`, read on first boot).
- Assistant role: \`${packageName}\` (\`config_defaultAssistant\`; ACTION_ASSIST activity \`${assistant}\`).
${autofill ? `- Autofill offer: \`${packageName}/${autofill}\` (\`config_defaultAutofillService\`).` : ""}

The stock launcher is not removed. These defaults are staging output; only a boot of
the built image shows that Android applied them.
`,
    productMakefile: `
# the launcher production provisioning (scripts/stage-aosp.mjs --production).
launcher_provisioning_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))/provisioning
PRODUCT_PACKAGE_OVERLAYS += $(launcher_provisioning_dir)/overlay
PRODUCT_COPY_FILES += $(launcher_provisioning_dir)/preferred-apps/launcher-home.xml:$(TARGET_COPY_OUT_PRODUCT)/etc/preferred-apps/launcher-home.xml
`,
  };
}

export function writeProvisioningOverlay(output, packageName, components) {
  const files = renderProvisioningOverlay(packageName, components);
  for (const [name, content] of Object.entries(files)) {
    if (name === "productMakefile") continue;
    const file = path.join(output, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: "wx" });
  }
  fs.appendFileSync(path.join(output, "product.mk"), files.productMakefile);
  return files;
}

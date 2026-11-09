/**
 * Runs BrowserLoginFields.SCRIPT (the login-field reporter) in jsdom with a stand-in channel and
 * checks the messages it sends. Layout is faked (every non-hidden input is shown); WebView, the
 * isolated world and Android Autofill are not run here.
 */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

const java = readFileSync(
  resolve(
    import.meta.dirname,
    "../android/src/main/java/ai/eliza/plugins/browsersurface/BrowserLoginFields.java",
  ),
  "utf8",
);
// The Java text block holds the script with its backslashes escaped.
const script = (java.split('static final String SCRIPT = """\n')[1] ?? "")
  .split('""";')[0]
  .replaceAll("\\\\", "\\");

type Page = {
  window: Window & typeof globalThis & { eval(code: string): unknown };
  document: Document;
  messages: string[];
  fill(data: Record<string, unknown>): void;
};

/** A page at https://example.com with the reporter installed; messages drop the document id and box. */
function page(html: string): Page {
  const dom = new JSDOM(html, {
    url: "https://example.com/",
    runScripts: "outside-only",
  });
  const window = dom.window as unknown as Page["window"];
  const messages: string[] = [];
  const raw: string[] = [];
  const listeners: ((event: { data: string }) => void)[] = [];
  Object.defineProperty(window, "isSecureContext", { value: true });
  if (!window.crypto?.getRandomValues)
    Object.defineProperty(window, "crypto", { value: webcrypto });
  window.Element.prototype.getClientRects = function (this: Element) {
    return (this instanceof window.HTMLInputElement && this.type === "hidden"
      ? []
      : [{}]) as unknown as DOMRectList;
  };
  Object.assign(window, {
    __elizaLoginFields: {
      postMessage(message: string) {
        raw.push(message);
        messages.push(
          message.replace(/\|[0-9a-f]{24}/, "").replace(/\|[-0-9.,]+$/, ""),
        );
      },
      addEventListener(
        _type: string,
        listener: (event: { data: string }) => void,
      ) {
        listeners.push(listener);
      },
    },
  });
  window.eval(script);
  // A page that signs in with script: jsdom cannot navigate a form submit.
  window.addEventListener("submit", (event) => event.preventDefault());
  return {
    window,
    document: window.document,
    messages,
    fill(data) {
      const document = raw[0]?.split("|")[1];
      for (const listener of listeners)
        listener({
          data: JSON.stringify({
            t: "fill",
            d: document,
            o: "https://example.com",
            ...data,
          }),
        });
    },
  };
}

const input = (p: Page, id: string) =>
  p.document.getElementById(id) as HTMLInputElement;
const submit = (p: Page, id: string) =>
  (p.document.getElementById(id) as HTMLFormElement).requestSubmit();

it("saves a read-only username beside the password but never fills it", () => {
  const p = page(
    `<form id=f><input id=u type=email readonly value="a@b.c"><input id=p type=password></form>`,
  );
  input(p, "u").focus();
  expect(p.messages).toEqual([]);
  input(p, "p").focus();
  expect(p.messages).toEqual(["focus|2|1|2||"]);
  p.fill({ u: 1, uv: "other@example.com", p: 2, pv: "filled" });
  expect(input(p, "u").value).toBe("a@b.c");
  expect(input(p, "p").value).toBe("filled");
  submit(p, "f");
  expect(p.messages.at(-1)).toBe("submit|1|2|a%40b.c|filled");
});

it("saves the identifier an earlier step of the same document submitted", () => {
  const p = page(
    `<form id=a><input id=e type=email autocomplete=username></form><div id=slot></div>`,
  );
  input(p, "e").value = "x@y.z";
  submit(p, "a");
  p.document.getElementById("a")?.remove();
  (p.document.getElementById("slot") as HTMLElement).innerHTML =
    "<form id=b><input id=p type=password></form>";
  input(p, "p").focus();
  input(p, "p").value = "pw";
  submit(p, "b");
  expect(p.messages).toEqual(["focus|2|1|2||", "submit|1|2|x%40y.z|pw"]);
});

it("keeps a formless login apart from a newsletter form", () => {
  const p = page(
    `<div><input id=u type=text><input id=p type=password></div><form><input id=n type=email autocomplete=email></form>`,
  );
  input(p, "u").focus();
  input(p, "p").focus();
  expect(p.messages).toEqual(["focus|1|1|2||", "blur", "focus|2|1|2||"]);
  p.fill({ u: 1, uv: "ada", p: 2, pv: "pw" });
  expect(input(p, "u").value).toBe("ada");
  expect(input(p, "n").value).toBe("");
});

it("reports a formless login beside a signup form", () => {
  const p = page(
    `<div><input id=u type=text><input id=p type=password></div><form><input type=email><input type=password></form>`,
  );
  input(p, "u").focus();
  input(p, "p").focus();
  expect(p.messages).toEqual(["focus|1|1|2||", "blur", "focus|2|1|2||"]);
});

it("saves a password the page revealed as text before submit", () => {
  const p = page(
    `<form id=f><input id=u type=text><input id=p type=password></form>`,
  );
  input(p, "p").focus();
  input(p, "u").value = "ada";
  input(p, "p").value = "pw";
  input(p, "p").type = "text";
  submit(p, "f");
  expect(p.messages).toEqual(["focus|2|1|2||", "submit|1|2|ada|pw"]);
});

it("follows focus between fields inside one shadow root, once per move", () => {
  const p = page(`<input id=o><div id=h></div>`);
  const root = (p.document.getElementById("h") as HTMLElement).attachShadow({
    mode: "open",
  });
  root.innerHTML =
    "<input id=n type=text><form><input id=u type=text><input id=p type=password></form>";
  input(p, "o").focus();
  (root.getElementById("n") as HTMLInputElement).focus();
  (root.getElementById("u") as HTMLInputElement).focus();
  (root.getElementById("p") as HTMLInputElement).focus();
  input(p, "o").focus();
  expect(p.messages).toEqual([
    "focus|1|1|2||",
    "blur",
    "focus|2|1|2||",
    "blur",
  ]);
});

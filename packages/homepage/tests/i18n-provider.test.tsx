/**
 * Mounted provider tests with real React/jsdom and controlled locale-chunk
 * transport. Delayed completion, superseded requests, and rejected imports
 * exercise what homepage consumers and the host error boundary observe.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

type Messages = Record<string, string>;
const requests: {
  lang: string;
  resolve: (messages: Messages) => void;
  reject: (error: Error) => void;
}[] = [];
mock.module("../src/providers/language-messages", () => ({
  loadLanguageMessages: (lang: string) =>
    new Promise<Messages>((resolve, reject) =>
      requests.push({ lang, resolve, reject }),
    ),
}));
mock.module("@elizaos/ui/i18n/region", () => ({
  detectClientLanguage: () => "en",
}));
const { I18nProvider, useI18n } = await import("../src/providers/I18nProvider");
let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let changeLanguage: (language: string) => void;
const caught: Error[] = [];
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    caught.push(error);
  }
  render() {
    return this.state.failed ? (
      <p role="alert">Language unavailable</p>
    ) : (
      this.props.children
    );
  }
}
function Consumer() {
  const { lang, setLang, t } = useI18n();
  changeLanguage = setLang;
  return (
    <p>
      {lang}:{t("greeting", { defaultValue: "Hello" })}:
      {t("missing", { defaultValue: "Fallback" })}
    </p>
  );
}
beforeEach(() => {
  requests.length = 0;
  caught.length = 0;
  dom = new JSDOM('<div id="root"></div>', { url: "https://example.test/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  container = dom.window.document.getElementById("root") as HTMLElement;
  root = createRoot(container, { onCaughtError: () => {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
});
async function mount() {
  await act(async () =>
    root.render(
      <Boundary>
        <I18nProvider initialLang="es">
          <Consumer />
        </I18nProvider>
      </Boundary>,
    ),
  );
}
test("publishes a completed locale to mounted consumers without another language change", async () => {
  await mount();
  expect(container.textContent).toBe("es:Hello:Fallback");
  await act(async () => requests[0].resolve({ greeting: "Hola" }));
  expect(container.textContent).toBe("es:Hola:Fallback");
});
test("ignores superseded load failures and completion without reverting the current locale", async () => {
  await mount();
  await act(async () => changeLanguage("ja"));
  expect(requests.map((request) => request.lang)).toEqual(["es", "ja"]);
  await act(async () => requests[1].resolve({ greeting: "こんにちは" }));
  await act(async () => requests[0].reject(new Error("superseded")));
  expect(container.textContent).toBe("ja:こんにちは:Fallback");
  expect(caught).toEqual([]);
  await act(async () => changeLanguage("pt"));
  await act(async () => changeLanguage("ko"));
  await act(async () => requests[3].resolve({ greeting: "안녕하세요" }));
  await act(async () => requests[2].resolve({ greeting: "Olá" }));
  expect(container.textContent).toBe("ko:안녕하세요:Fallback");
});
test("surfaces a current locale import failure through the host error boundary", async () => {
  await mount();
  const failure = new Error("chunk unavailable");
  await act(async () => requests[0].reject(failure));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Language unavailable",
  );
  expect(caught[0]?.cause).toBe(failure);
});

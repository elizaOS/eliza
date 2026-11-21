// spec/cloud/returnPages.md, "A return URL on the web origin shows ReturnToApp only for the one enabled registration of the served environment that holds it"; spec/cloud/returnPages.md, "The page's one action opens the registered return in the package of the registration that holds it"; spec/cloud/returnPages.md, "The pinned script forwards into the app link only the purpose's well-formed results, where the app reads them"; spec/cloud/returnPages.md, "Every page is private, unframed and unindexed, has no form, and runs at most the pinned script"; spec/cloud/returnPages.md, "The payer page shows the paid copy only for outcome=paid, the closed copy for anything else, reads nothing else and offers no action"; spec/cloud/nativeClients/registry.md, "A return URL names at most one enabled registration and purpose, and the cloud serves it only on the environment's web origin"
import { always } from "@antithesishq/bombadil";
import { actions, extract, type State } from "@antithesishq/bombadil/browser";
import { forwardScript } from "../src/pages/pinned-script.ts";
import seed from "./fixtures/seed.json" with { type: "json" };
export * from "@antithesishq/bombadil/browser/defaults";

const [fixture] = seed.clients;
const webOrigin = /^https:\/\/[^/]+/.exec(fixture.signInReturn)?.[0] ?? "";
const webHost = webOrigin.slice("https://".length);
const returnPaths = [fixture.signInReturn, fixture.billingReturn, fixture.connectReturn].map((address) => address.slice(webOrigin.length));
const payerPath = "/api/v1/subscriptions/checkout/payer";

const isPage = (state: State) => state.document.contentType === "text/html" && /^https?:$/.test(state.window.location.protocol);
const isPayerPage = (state: State) => isPage(state) && state.window.location.pathname === payerPath;
const isReturnToApp = (state: State) => isPage(state) && returnPaths.includes(state.window.location.pathname);

const valuesOf = (address: string): string[] => {
  const hashAt = address.indexOf("#");
  const beforeHash = hashAt === -1 ? address : address.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const parts = [queryAt === -1 ? "" : beforeHash.slice(queryAt + 1), hashAt === -1 ? "" : address.slice(hashAt + 1)];
  return parts.flatMap((part) =>
    part.split("&").flatMap((pair) => {
      const raw = pair.slice(pair.indexOf("=") + 1);
      if (!pair.includes("=") || raw === "") return [];
      try {
        return [raw, decodeURIComponent(raw.replaceAll("+", " "))];
      } catch {
        return [raw];
      }
    }),
  );
};

const valueShown = extract((state) => {
  if (!isPage(state)) return false;
  const { back, current, forward } = state.navigationHistory;
  const loaded = state.window.performance.getEntriesByType("navigation").map((entry) => entry.name);
  const addresses = [state.window.location.href, ...loaded, ...[...back, current, ...forward].map((entry) => entry.url)];
  const values = new Set(addresses.flatMap(valuesOf).map((value) => value.trim()).filter((value) => value !== ""));
  return [...state.document.body.querySelectorAll("*")].some((element) => element.tagName !== "SCRIPT" && values.has((element.textContent ?? "").trim()));
});

const returnLinks = extract((state) =>
  isReturnToApp(state)
    ? {
        path: state.window.location.pathname,
        hrefs: [...state.document.querySelectorAll("a[href], area[href]")].map((link) => link.getAttribute("href") ?? ""),
      }
    : null,
);

const pageCode = extract((state) =>
  isPage(state)
    ? {
        forms: state.document.querySelectorAll("form").length,
        scripts: [...state.document.scripts].map((script) => ({ src: script.getAttribute("src"), type: script.getAttribute("type"), text: script.textContent ?? "" })),
        handlers: [...state.document.querySelectorAll("*")].some((element) => element.getAttributeNames().some((name) => name.startsWith("on"))),
      }
    : null,
);

const payerActions = extract((state) => (isPayerPage(state) ? state.document.querySelectorAll("a[href], area[href], form, script").length : 0));

const addressScrubbed = extract((state) => !isReturnToApp(state) || (state.window.location.search === "" && state.window.location.hash === ""));

const intentTail = `#Intent;scheme=https;package=${fixture.androidPackage};end`;

export const noQueryOrFragmentValueShown = always(() => !valueShown.current);

export const returnToAppOpensOnlyTheFixtureApp = always(() => {
  const page = returnLinks.current;
  if (page === null) return true;
  const [href, ...others] = page.hrefs;
  const target = `intent://${webHost}${page.path}`;
  if (href === undefined || others.length > 0 || !href.startsWith(target) || !href.endsWith(intentTail)) return false;
  const forwarded = href.slice(target.length, href.length - intentTail.length);
  return forwarded === "" || /^\?[^#]+$/.test(forwarded) || /^#[^#]+$/.test(forwarded);
});

export const onlyThePinnedScriptRuns = always(() => {
  const page = pageCode.current;
  if (page === null) return true;
  const [script, ...others] = page.scripts;
  return page.forms === 0 && !page.handlers && (script === undefined || (others.length === 0 && script.src === null && script.type === null && script.text === forwardScript));
});

export const checkoutOutcomeOffersNoAction = always(() => payerActions.current === 0);

export const returnToAppScrubsTheAddress = always(() => addressScrubbed.current);

export const revisit = actions(() => ["Reload", "Wait"]);

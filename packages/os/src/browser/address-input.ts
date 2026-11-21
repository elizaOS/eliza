//@ backend dafny
// spec/os/browser/address.md, "Typed text is an address to open, words to search for, or a refusal with its reason"; spec/os/browser/address.md, "Only an HTTP or HTTPS address that parsed without credentials is ever opened"; spec/os/browser/address.md, "A search never carries an at sign to the search provider"
import { type AddressFacts, type AddressRefusal, type DefaultProtocol, classifyAddress } from "../../gen/os__browser__address.ts";

export type AddressRefusalReason = "empty" | "invalid-input" | "invalid-url" | "credentials" | "unsupported-protocol";

export type BrowserAddressInput =
  | { kind: "url"; href: string }
  | { kind: "search"; query: string }
  | { kind: "rejected"; reason: AddressRefusalReason };

//@ pure
export function refusalReason(reason: AddressRefusal): AddressRefusalReason {
  switch (reason) {
    case "EmptyAddress": return "empty";
    case "InvalidAddressInput": return "invalid-input";
    case "InvalidAddressUrl": return "invalid-url";
    case "AddressCredentials": return "credentials";
    case "UnsupportedProtocol": return "unsupported-protocol";
  }
}

//@ pure
export function browserAddressInput(facts: AddressFacts, fallback: DefaultProtocol): BrowserAddressInput {
  //@ ensures facts.blank ==> \result.kind === "rejected" && \result.reason === "empty"
  //@ ensures (facts.hasControl && !facts.blank) ==> \result.kind === "rejected" && \result.reason === "invalid-input"
  //@ ensures \result.kind === "url" ==> facts.parses && !facts.userInfo && !facts.hasControl && schemeFor(facts, fallback) !== "OtherScheme" && \result.href === facts.href
  //@ ensures (\result.kind === "url" && !explicitScheme(facts)) ==> schemeFor(facts, fallback) === defaultScheme(fallback)
  //@ ensures (explicitScheme(facts) && facts.typedScheme === "OtherScheme") ==> \result.kind !== "url"
  //@ ensures \result.kind === "search" ==> !facts.hasAt && \result.query === facts.text
  const result = classifyAddress(facts, fallback);
  switch (result.tag) {
    case "AddressUrl": return { kind: "url", href: result.href };
    case "AddressSearch": return { kind: "search", query: result.query };
    case "AddressRejected": return { kind: "rejected", reason: refusalReason(result.reason) };
  }
}

/**
 * The OAuth completion popups write request values into an inline <script>.
 * JSON quoting does not stop `</script>` from ending the element, so a query
 * value could end the script early and start another one. Values are serialized with
 * `serializeInlineScriptValue`, which escapes `<`, `>` and `&`.
 */
import { expect, test } from "bun:test";
import paypalPopup from "../../../v1/eliza/paypal/popup-callback/route";
import connectionSuccess from "./route";

const BREAKOUT = "</script><script>window.__extra=1</script>";

test("connection-success does not let a query value end its script", async () => {
  const response = await connectionSuccess.request(
    `/?source=eliza-app&platform=${encodeURIComponent(BREAKOUT)}&connection_id=${encodeURIComponent(BREAKOUT)}`,
    {},
    { AGENT_APP_ORIGIN: "https://app.example.test" },
  );
  const html = await response.text();
  expect(html).not.toContain("<script>window.__extra");
  expect(html.match(/<\/script>/g)?.length).toBe(1);
});

test("paypal popup-callback does not let a query value end its script", async () => {
  const response = await paypalPopup.request(
    `/?code=${encodeURIComponent(BREAKOUT)}&state=${encodeURIComponent(BREAKOUT)}`,
    {},
    { AGENT_APP_ORIGIN: "https://app.example.test" },
  );
  const html = await response.text();
  expect(html).not.toContain("<script>window.__extra");
  expect(html.match(/<\/script>/g)?.length).toBe(1);
});

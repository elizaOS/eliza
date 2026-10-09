const address = location.hash.slice(1),
  host = document.querySelector("#host");
try {
  host.textContent = new URL(address).hostname;
} catch {
  host.textContent = "Invalid address";
  document.querySelector("#ask").disabled = true;
}
const { protection } = await chrome.storage.local
  .get("protection")
  .catch(() => ({}));
document.querySelector("#status").textContent =
  protection?.status === "current" &&
  Number.isFinite(protection.publishedAt) &&
  protection.publishedAt <= Date.now() + 300000 &&
  Date.now() - protection.publishedAt < 48 * 3600000
    ? "The page has not been opened."
    : "The page has not been opened. Protection updates are unavailable; this warning uses the last saved list.";
document.querySelector("#back").onclick = () =>
  history.length > 1
    ? history.back()
    : chrome.tabs.update({ url: "chrome://newtab/" });
document.querySelector("#ask").onclick = () => {
  document.querySelector("#confirmation").hidden = false;
  document.querySelector("#ask").hidden = true;
  document.querySelector("#cancel").focus();
};
document.querySelector("#cancel").onclick = () => {
  document.querySelector("#confirmation").hidden = true;
  document.querySelector("#ask").hidden = false;
  document.querySelector("#ask").focus();
};
document.querySelector("#confirm").onclick = async () => {
  const button = document.querySelector("#confirm");
  button.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: "open-temporarily",
    });
    if (!reply?.ok) throw Error("Navigation failed");
  } catch {
    document.querySelector("#status").textContent =
      "This page could not be opened. Go back and use a trusted address.";
    document.querySelector("#back").focus();
  } finally {
    button.disabled = false;
  }
};
if (window.top !== window.self) document.querySelector("#ask").hidden = true;
